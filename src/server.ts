import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Store} from './store.ts';
import {Engine} from './engine.ts';
import type {Site} from './engine.ts';
import {BrowserSite} from './browser.ts';
import {acquireInstance} from './instance.ts';
import {resolveConfig} from './config.ts';

const project=resolve(import.meta.dirname,'..');
export interface AppOptions {instance?:{port:number;dataDir:string};}
async function jsonBody(req:IncomingMessage):Promise<any>{
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>262144)throw Error('导入文件过大（最大256KB）');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Error('任务内容不是有效的JSON');}
}
function json(res:ServerResponse,status:number,value:unknown):void{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
export function createApp(store:Store,site:Site,options:AppOptions={}){
  const engine=new Engine(store,site),localToken=randomBytes(24).toString('hex');let lastError='';let operation=Promise.resolve();
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port=(server.address() as {port:number}|null)?.port,origin=`http://127.0.0.1:${port}`;
    if(req.headers.host!==`127.0.0.1:${port}`||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'){json(res,403,{error:'仅允许本机控制页访问'});return;}
    const url=new URL(req.url||'/',origin);
    try{
      if(req.method==='GET'&&url.pathname==='/api/state'){
        json(res,200,{tasks:store.state.tasks,freeze:store.state.freeze||null,site:engine.cached||null,localToken,busy:engine.busy,lastError,now:Date.now(),instance:options.instance??null});return;
      }
      if(req.method==='GET'){
        const files:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
        const f=files[url.pathname];if(!f){json(res,404,{error:'未找到'});return;}
        res.writeHead(200,{'content-type':f[1]+'; charset=utf-8','cache-control':'no-cache'});res.end(await readFile(join(project,'public',f[0])));return;
      }
      if(req.method!=='POST'){json(res,405,{error:'不支持此操作'});return;}
      const incoming=req.headers['x-local-token'];
      if(typeof incoming!=='string'||incoming.length!==localToken.length||!timingSafeEqual(Buffer.from(incoming),Buffer.from(localToken))||!req.headers['content-type']?.startsWith('application/json')){json(res,403,{error:'请从本机控制页操作'});return;}
      const body=await jsonBody(req);
      const run=async()=>{
        if(engine.busy)throw Error('预约或演练正在执行，请稍后操作');
        let result:any={},status=200;
        if(url.pathname==='/api/tasks'){result=store.add(body);status=201;}
        else if(url.pathname==='/api/import'){result={tasks:store.importTasks(body)};status=201;}
        else if(url.pathname==='/api/calendar'){result=await engine.calendar(body.start,body.end);}
        else if(url.pathname==='/api/login'){
          const b=site as Site&{open?:()=>Promise<void>};await b.open?.();result={message:'请在专用Edge窗口扫码，然后返回检查登录'};
        }else if(url.pathname==='/api/check'){result=await engine.inspect(undefined,{manual:true});lastError='';}
        else {
          const m=/^\/api\/tasks\/([\w-]+)\/(arm|cancel|rehearse|reconcile|confirm)$/.exec(url.pathname);
          if(!m){json(res,404,{error:'未找到此操作'});return;}
          const [,id,action]=m;
          if(action==='arm')await engine.arm(id);
          if(action==='cancel')engine.cancel(id);
          if(action==='rehearse')await engine.rehearseNow(id);
          if(action==='reconcile')await engine.reconcile(id);
          if(action==='confirm')engine.confirmManual(id,body.confirmation);
          result=store.get(id);
        }
        json(res,status,result);
      };
      const pending=operation.then(run);operation=pending.catch(()=>{});await pending;
    }catch(e){lastError=e instanceof Error?e.message:'操作未完成';json(res,400,{error:lastError});}
  });
  return {server,engine};
}
async function main():Promise<void>{
  const config=resolveConfig(project);
  const directory=config.dataDir,release=acquireInstance(directory);
  process.once('exit',release);
  const store=await Store.open(directory),site=new BrowserSite(directory);
  const {server,engine}=createApp(store,site,{instance:{port:config.port,dataDir:config.dataDirName}}),url=config.url;
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port:config.port,exclusive:true},resolve);});
  }catch(e){if((e as NodeJS.ErrnoException).code==='EADDRINUSE')(e as NodeJS.ErrnoException & {instanceUrl?:string}).instanceUrl=url;throw e;}
  engine.start();
  console.log(`羽毛球预约程序已启动：${url}\n数据目录：${config.dataDirName}；请保持此窗口和专用Edge运行。按 Ctrl+C 停止等待；不会取消网站已有预约。`);
  if(config.open){
    const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
  }
  let stopping=false;
  const shutdown=async()=>{
    if(stopping)return;stopping=true;engine.stop();server.close();
    const end=Date.now()+25_000;while(engine.busy&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
    await site.close().catch(()=>{});process.exit(0);
  };
  process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch((e:NodeJS.ErrnoException & {instanceUrl?:string})=>{
  if(e?.code==='EADDRINUSE')console.error(`程序可能已运行，或端口被占用。请打开 ${e.instanceUrl??'控制页'}；若端口被其他程序占用，请先关闭占用程序。`);
  else console.error(e instanceof Error?e.message:String(e));
  process.exitCode=1;
});
