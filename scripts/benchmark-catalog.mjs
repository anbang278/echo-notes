import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const root = process.cwd();
const iterations = Number(process.env.ECHO_CATALOG_BENCHMARK_ITERATIONS ?? 30);
const meetingCount = Number(process.env.ECHO_CATALOG_BENCHMARK_MEETINGS ?? 1000);
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(meetingCount) || meetingCount < 10 || meetingCount > 10_000) throw new Error("Invalid benchmark size.");
await mkdir(path.join(root, ".tmp"), { recursive: true });
const output = path.join(root, ".tmp/catalog-benchmark.mjs");
await esbuild.build({
	stdin: {
		resolveDir: root,
		loader: "ts",
		contents: `
import { performance } from "node:perf_hooks";
import { CatalogRepository } from "./src/catalog/catalog-repository";
import { filterMeetings } from "./src/catalog/catalog-time";
import { createEvidenceQuery, searchEvidence, freezeEvidencePackage, renderEvidenceMarkdown } from "./src/evidence";
import type { EvidenceDocument, EvidenceMemory } from "./src/evidence";

export async function run(meetingCount: number, iterations: number) {
 const files = new Map<string, string>();
 const registry = {schemaVersion:1, meetingPaths:{}, projectPaths:{}, sourcePaths:{}, recordings:{}, legacyMeetings:{}, pendingMeetings:{}, intentMeetings:{}};
 const metadata = (properties: object, body: string) => "---\\n" + JSON.stringify(properties) + "\\n---\\n" + body;
 const projectId = "prj_00000000-0000-4000-8000-000000000001";
 const projectPath = "Memory/03 Entities/Projects/Fixture.md";
 registry.projectPaths[projectId] = projectPath;
 files.set(projectPath, metadata({echo_schema:1,echo_kind:"project",echo_project_id:projectId,echo_project_status:"active"},"# Fixture project\\n"));
 const padding = "Synthetic paragraph with no keyword. ".repeat(Math.ceil(20 * 1024 * 1024 / meetingCount / 36));
 const documents: EvidenceDocument[] = [];
 let transcriptBytes = 0;
 for(let index=0;index<meetingCount;index++) {
  const suffix = String(index).padStart(12,"0");
  const meetingId = "mtg_00000000-0000-4000-8000-"+suffix;
  const sourceId = "src_00000000-0000-4000-8000-"+suffix;
  const meetingPath = "Memory/01 Meetings/"+suffix+".md";
  const sourcePath = "Transcripts/"+suffix+".transcript.md";
  const date = "2026-11-"+String(index%28+1).padStart(2,"0");
  registry.meetingPaths[meetingId]=meetingPath;
  registry.sourcePaths[sourceId]=sourcePath;
  registry.legacyMeetings[sourcePath]=meetingId;
  files.set(meetingPath,metadata({echo_schema:1,echo_kind:"meeting",echo_meeting_id:meetingId,echo_project_ids:[projectId],echo_time_precision:"date",echo_meeting_date:date,echo_time_source:"user",echo_time_confirmed:true,tags:["fixture"]},"# Constructed meeting "+index+"\\n"));
  const source = metadata({type:"audio-transcript",echo_schema:1,echo_source_id:sourceId,echo_meeting_id:meetingId,status:"done"},"<!-- echo-notes-transcript:start -->\\n# Fixture transcript\\n\\n## 转写正文\\n\\n说话人甲：订单履约需要检查风险，先保留人工处理入口。\\n\\n"+padding+"\\n<!-- echo-notes-transcript:end -->\\n");
  files.set(sourcePath, source);
  transcriptBytes += new TextEncoder().encode(source).byteLength;
  documents.push({sourceId,meetingId,sourcePath,content:source,title:"Constructed meeting "+index,meetingDate:date,projectIds:[projectId]});
 }
 files.set("Memory/99 System/catalog-v1/registry.json",JSON.stringify(registry));
 const storage = {
  read: async(path: string) => files.get(path)??null,
  list: async(folder: string) => [...files.keys()].filter((path)=>path.startsWith(folder+"/")),
  create: async()=>{throw new Error("benchmark is read only");},
  write: async()=>{throw new Error("benchmark is read only");},
  process: async()=>{throw new Error("benchmark is read only");},
  remove: async()=>{throw new Error("benchmark is read only");}
 };
 const repository = new CatalogRepository({storage,yaml:{parse:JSON.parse,stringify:JSON.stringify},rootFolder:"Memory",language:"en",transcriptFolders:["Transcripts"]});
 const memories: EvidenceMemory[] = Array.from({length:20_000},(_,index)=>({id:"memory_"+index,text:"订单履约风险构造记忆 "+index,approval:"approved",resolvedValidity:"active",sourceId:documents[index%meetingCount].sourceId,meetingId:documents[index%meetingCount].meetingId,projectIds:[projectId],sourceCheck:"verified"}));
 const query = createEvidenceQuery("订单履约风险",{keywords:["订单履约","风险"],maxCharacters:20_000,contextBefore:0,contextAfter:0,filters:{projectIds:[projectId],meetingIds:[],timezone:"Asia/Taipei",sourceKinds:["transcript","approved_memory"]}});
 const snapshot = await repository.snapshot();
 const search = await searchEvidence(documents,query,memories);
 const measure = async(name: string, fn: ()=>Promise<unknown>|unknown, targetMs: number) => {
  for(let index=0;index<5;index++) await fn();
  const samples:number[]=[];
  for(let index=0;index<iterations;index++){const started=performance.now();await fn();samples.push(performance.now()-started);}
  samples.sort((a,b)=>a-b);
  const p50=samples[Math.max(0,Math.ceil(samples.length*.50)-1)];
  const p95=samples[Math.max(0,Math.ceil(samples.length*.95)-1)];
  return {name,iterations,warmup:5,p50Ms:Math.round(p50*100)/100,p95Ms:Math.round(p95*100)/100,initialTargetMs:targetMs,withinInitialTarget:p95<=targetMs};
 };
 const results=[];
 results.push(await measure("catalog_snapshot",()=>repository.snapshot(),500));
 results.push(await measure("metadata_filter",()=>filterMeetings(snapshot.meetings,{timezone:"Asia/Taipei",date:"2026-11-07",projectIds:[projectId],tags:["fixture"]}),150));
 results.push(await measure("lexical_search",()=>searchEvidence(documents,query,memories),1000));
 results.push(await measure("validate_freeze_markdown",async()=>renderEvidenceMarkdown(await freezeEvidencePackage(documents,query,{packageId:"benchmark_fixed",frozenAt:"2026-11-08T00:00:00Z",selection:search.selectedItems,memories})),1000));
 return {fixture:{constructed:true,meetings:meetingCount,transcriptBytes,memoryRecords:memories.length,seed:"v05-catalog-20261108",metadataCodec:"JSON-compatible YAML",storage:"in-memory, no disk latency",memoryInput:"constructed jointly-evaluated records; authority-file reading excluded"},results};
}
`
	},
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: output,
	logLevel: "silent"
});
const benchmark = await import(pathToFileURL(output).href);
const result = await benchmark.run(meetingCount, iterations);
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", compiler: `esbuild ${esbuild.version}` }, ...result };
const reportPath = path.join(root, "output/verification/catalog-benchmark.json");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
