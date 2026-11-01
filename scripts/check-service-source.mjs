#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),service=process.argv[2];
if(!['restore-journal','push-provider'].includes(service)||process.argv.length!==3)throw Error('Select restore-journal or push-provider');
const source=path.join(root,'services',service,'src');let count=0;
for(const entry of (await fs.readdir(source,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  if(entry.isFile()&&entry.name.endsWith('.mjs')) {
    execFileSync(process.execPath,['--check',path.join(source,entry.name)],{stdio:'inherit'});count++;
  }
}
if(!count)throw Error('No service source checked');
process.stdout.write(`${service}: ${count} JavaScript source files checked; no service started or deployed.\n`);
