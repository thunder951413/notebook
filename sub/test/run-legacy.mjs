// Every legacy UI suite gets a fresh workspace and an ephemeral port.
import { spawn } from 'node:child_process';
import { startServerFixture } from './server-fixture.mjs';
for (const name of ['md', 'dom', 'flow', 'meta', 'lock']) {
  const cleanup=[];
  const fixture=await startServerFixture({after: fn=>cleanup.push(fn)});
  try {
    const a=fixture.store.createNotebook({name:'工作',emoji:'📓'});
    fixture.store.createNotebook({name:'生活',emoji:'📒'});
    await fixture.store.createPage({notebookId:a.id,title:'欢迎笔记',markdown:'# 欢迎笔记\n\n欢迎测试。'});
    const code=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[new URL('./'+name+'-test.mjs',import.meta.url).pathname],{stdio:'inherit',env:{...process.env,NOTEBOOK_TEST_URL:fixture.baseUrl}});
      child.on('error',reject);child.on('exit',resolve);
    });
    if(code!==0)throw new Error(name+' suite failed: '+code);
  } finally {for(const fn of cleanup.reverse())await fn();}
}
