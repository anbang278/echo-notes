"""Tiny dependency-free ASGI driver; application logic tests, not socket emulation."""
import asyncio
import json as json_module
from urllib.parse import urlsplit


class Response:
    def __init__(self, status, content):
        self.status_code = status
        self.text = content.decode('utf-8')
    def json(self):
        return json_module.loads(self.text)


class Client:
    def __init__(self, app):
        self.app = app

    async def request(self, method, path, content=None, json=None, headers=None):
        headers = {k.lower(): v for k,v in (headers or {}).items()}
        headers.setdefault('host','127.0.0.1')
        if json is not None:
            content=json_module.dumps(json).encode();headers['content-type']='application/json'
        async def single():
            yield content or b''
        body=content.__aiter__() if hasattr(content,'__aiter__') else single().__aiter__()
        ended=False
        async def receive():
            nonlocal ended
            if ended:
                await asyncio.Event().wait()
            try:
                chunk=await body.__anext__()
                return {'type':'http.request','body':chunk,'more_body':True}
            except StopAsyncIteration:
                ended=True
                return {'type':'http.request','body':b'','more_body':False}
        response_status=0
        response_body=bytearray()
        async def send(message):
            nonlocal response_status
            if message['type']=='http.response.start':response_status=message['status']
            if message['type']=='http.response.body':response_body.extend(message.get('body',b''))
        scope={'type':'http','asgi':{'version':'3.0','spec_version':'2.4'},'http_version':'1.1',
               'method':method,'scheme':'http','path':path,'raw_path':path.encode(),'query_string':b'',
               'root_path':'','headers':[(k.encode(),v.encode()) for k,v in headers.items()],
               'client':('127.0.0.1',1234),'server':('127.0.0.1',80)}
        await asyncio.wait_for(self.app(scope,receive,send),10)
        return Response(response_status,bytes(response_body))

    async def post(self,path,**kwargs):return await self.request('POST',path,**kwargs)
    async def put(self,path,**kwargs):return await self.request('PUT',path,**kwargs)
    async def get(self,path,**kwargs):return await self.request('GET',path,**kwargs)
    async def delete(self,path,**kwargs):return await self.request('DELETE',path,**kwargs)
    async def aclose(self):pass
