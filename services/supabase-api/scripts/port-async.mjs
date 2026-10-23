// One-time source conversion helper. Every resulting asynchronous call is typechecked
// and PostgreSQL behavior is tested; this helper is not a runtime dependency.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../src');
const files=fs.readdirSync(root).filter(x=>x.endsWith('.ts')).map(x=>path.join(root,x));
const program=ts.createProgram(files,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,moduleResolution:ts.ModuleResolutionKind.Bundler,strict:true,skipLibCheck:true});
const checker=program.getTypeChecker(), fns=new Set(), marked=new Set(), callbackOps=new Set(['map','filter','some','every','find','forEach']);
const isFn=n=>ts.isFunctionDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isMethodDeclaration(n);
for(const file of program.getSourceFiles().filter(x=>files.includes(x.fileName))) { const visit=n=>{if(isFn(n)&&n.body)fns.add(n);ts.forEachChild(n,visit);};visit(file); }
function declaration(expr){ let sym=checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr)?expr.name:expr); if(sym?.flags&ts.SymbolFlags.Alias)sym=checker.getAliasedSymbol(sym);let d=sym?.valueDeclaration;if(d&&ts.isVariableDeclaration(d))d=d.initializer;return d; }
function markedCall(n){
 if(!ts.isCallExpression(n))return false;
 if(ts.isPropertyAccessExpression(n.expression)&& /(?:^|\.)db\.(all|one|run|transaction)$/.test(n.expression.getText()))return true;
 if(ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='assertActor')return true;
 if(ts.isIdentifier(n.expression)&&n.expression.text==='assertAuthority')return true;
 if(marked.has(declaration(n.expression)))return true;
 return ts.isPropertyAccessExpression(n.expression)&&callbackOps.has(n.expression.name.text)&&n.arguments.some(a=>marked.has(a)||marked.has(declaration(a)));
}
let changed=true;while(changed){changed=false;for(const f of fns){if(marked.has(f))continue;let yes=false; const visit=n=>{if(n!==f&&isFn(n))return; if(markedCall(n))yes=true;ts.forEachChild(n,visit);};visit(f);if(yes){marked.add(f);changed=true;}}}
for(const file of program.getSourceFiles().filter(x=>files.includes(x.fileName))) {
 const helpers=new Set();
 const output=ts.transform(file,[context=>{
  const visit=n=>{
   if(isFn(n)&&n.body&&marked.has(n)){
    const mods=ts.factory.createNodeArray([...(n.modifiers??[]).filter(x=>x.kind!==ts.SyntaxKind.AsyncKeyword),ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)]);
    let type=n.type;
    if(type&&!(ts.isTypeReferenceNode(type)&&type.typeName.getText()==='Promise'))type=ts.factory.createTypeReferenceNode('Promise',[type]);
    const body=ts.visitNode(n.body,visit);
    if(ts.isFunctionDeclaration(n))return ts.factory.updateFunctionDeclaration(n,mods,n.asteriskToken,n.name,n.typeParameters,n.parameters,type,body);
    if(ts.isArrowFunction(n))return ts.factory.updateArrowFunction(n,mods,n.typeParameters,n.parameters,type,n.equalsGreaterThanToken,body);
    if(ts.isFunctionExpression(n))return ts.factory.updateFunctionExpression(n,mods,n.asteriskToken,n.name,n.typeParameters,n.parameters,type,body);
   }
   if(ts.isCallExpression(n)&&markedCall(n)){
    let call=ts.visitEachChild(n,visit,context);
    if(ts.isPropertyAccessExpression(n.expression)&&callbackOps.has(n.expression.name.text)&&n.arguments.some(a=>marked.has(a)||marked.has(declaration(a)))){
     const helper='async'+n.expression.name.text[0].toUpperCase()+n.expression.name.text.slice(1);helpers.add(helper);
     call=ts.factory.createCallExpression(ts.factory.createIdentifier(helper),n.typeArguments,[ts.visitNode(n.expression.expression,visit),...n.arguments.map(a=>ts.visitNode(a,visit))]);
    }
    return ts.isAwaitExpression(n.parent)?call:ts.factory.createParenthesizedExpression(ts.factory.createAwaitExpression(call));
   }
   return ts.visitEachChild(n,visit,context);
  };return node=>ts.visitNode(node,visit);
 }]).transformed[0];
 const printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed});
 let text=printer.printFile(output);
 if(helpers.size)text=`import { ${[...helpers].join(', ')} } from './async-collections';\n`+text;
 text=text.replace(/from '(\.\/[^']+)'/g,(_,x)=>`from '${x}.ts'`);
 fs.writeFileSync(file.fileName,text);
}
console.log(`Converted ${marked.size} functions across ${files.length} modules`);
