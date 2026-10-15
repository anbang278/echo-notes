"""Bounded multipart parsing: one audio file on disk, small scalar fields."""
import os
from python_multipart import MultipartParser
from python_multipart.multipart import parse_options_header
from job_store import JobError, MAX_FILE_BYTES


class MultipartAudio:
    def __init__(self, content_type, path):
        kind, options = parse_options_header(content_type)
        boundary = options.get(b"boundary")
        if kind != b"multipart/form-data" or not boundary or len(boundary) > 200:
            raise JobError(422, "invalid_multipart", "Expected multipart/form-data with a boundary")
        self.output = path.open("wb")
        os.chmod(path, 0o600)
        self.fields, self.headers = {}, {}
        self.field, self.value, self.name = bytearray(), bytearray(), None
        self.file_seen = self.ended = self.is_file = False
        self.size = self.header_size = self.parts = 0
        self.parser = MultipartParser(boundary, {
            "on_part_begin": self.begin, "on_header_field": self.header_field,
            "on_header_value": self.header_value, "on_header_end": self.header_end,
            "on_headers_finished": self.headers_done, "on_part_data": self.data,
            "on_part_end": self.end_part, "on_end": self.end,
        })

    def begin(self):
        self.parts += 1
        if self.parts > 8:
            raise JobError(422, "invalid_multipart", "Too many multipart fields")
        self.headers, self.field, self.value = {}, bytearray(), bytearray()
        self.header_size = 0

    def header_field(self, data, start, end):
        self.header_size += end - start
        if self.header_size > 8192:
            raise JobError(413, "headers_too_large", "Multipart headers are too large")
        self.field.extend(data[start:end])

    def header_value(self, data, start, end):
        self.header_size += end - start
        if self.header_size > 8192:
            raise JobError(413, "headers_too_large", "Multipart headers are too large")
        self.value.extend(data[start:end])

    def header_end(self):
        self.headers[bytes(self.field).lower()] = bytes(self.value)
        self.field, self.value = bytearray(), bytearray()

    def headers_done(self):
        disposition, options = parse_options_header(self.headers.get(b"content-disposition", b""))
        self.name = options.get(b"name", b"").decode("utf-8", "strict")
        self.is_file = b"filename" in options
        if disposition != b"form-data" or self.name not in {"file", "model", "language", "response_format"}:
            raise JobError(422, "invalid_multipart", "Unsupported multipart field")
        if self.is_file:
            if self.name != "file" or self.file_seen:
                raise JobError(422, "invalid_multipart", "Exactly one audio file is allowed")
            self.file_seen = True
        elif self.name == "file" or self.name in self.fields:
            raise JobError(422, "invalid_multipart", "Duplicate or invalid field")
        self.value = bytearray()

    def data(self, data, start, end):
        if self.is_file:
            self.size += end - start
            if self.size > MAX_FILE_BYTES:
                raise JobError(413, "file_too_large", "Audio exceeds the 1 GiB limit")
            self.output.write(memoryview(data)[start:end])
        else:
            if len(self.value) + end - start > 4096:
                raise JobError(413, "field_too_large", "Multipart field is too large")
            self.value.extend(data[start:end])

    def end_part(self):
        if not self.is_file:
            self.fields[self.name] = self.value.decode("utf-8", "strict")

    def end(self):
        self.ended = True

    def write(self, data):
        self.parser.write(data)

    def finish(self):
        self.parser.finalize()
        if not self.ended or not self.file_seen:
            raise JobError(422, "invalid_multipart", "Multipart upload is incomplete")
        self.output.flush()
        os.fsync(self.output.fileno())
        return self.fields, self.size

    def close(self):
        self.output.close()
