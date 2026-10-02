import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";
import { admittedTransaction, openWriteDatabase } from "../src/database.mjs";
const semantics={basis:"asserted",context_role:"on_demand",lifecycle:"current",applicability:{project:null,checkout:null}};
for (const flag of ["--raw","--history"]) {
 test(`returned ${flag} basis preserves null and idempotent/stale behavior`,async(t)=>{
  const f=await fixture(t);const id="knowledge:raw-roundtrip";
  await f.create(id,"knowledge",{value:1},"global",semantics);
  const read=await f.cli(["get",id,flag]);assert.equal(read.code,0);
  const basis=read.value.data.write_basis;assert.equal(basis.project_scope,null);
  const request={v:5,request_id:"update-raw",write_basis:basis,input:{mode:"update",id,set:{data:{value:2}},remove:[]}};
  const after=await f.cli(["put"],request);assert.equal(after.code,0,JSON.stringify(after.value));
  assert.equal((await f.cli(["get",id])).value.data.data.value,2);
  const replay=await f.cli(["put"],request);assert.equal(replay.code,0);assert.equal(replay.value.revision,after.value.revision);
  const stale=await f.cli(["put"],{...request,request_id:"different-write",input:{...request.input,set:{data:{value:3}}}});
  assert.notEqual(stale.code,0);assert.equal((await f.cli(["get",id])).value.data.data.value,2);
 });
 test(`returned ${flag} basis preserves scoped rejection`,async(t)=>{
  const f=await fixture(t);await f.create("project:test","project",{roots:[f.root]},"project:test");
  await f.create("knowledge:scoped","knowledge",{value:1},"project:test",{context_role:"on_demand",lifecycle:"current"});
  const read=await f.cli(["get","knowledge:scoped",flag]);assert.equal(read.code,0);
  assert.equal(read.value.data.write_basis.project_scope,"project:test");
  const result=await f.cli(["put"],{v:5,request_id:"bad-scope",write_basis:read.value.data.write_basis,
    input:{mode:"update",id:"knowledge:scoped",set:{semantics:{basis:"asserted",lifecycle:"current",context_role:"on_demand",applicability:{project:"other",checkout:null}}},remove:[]}});
  assert.notEqual(result.code,0);
 });
}
test("raw inspection remains available when semantic metadata needs repair",async(t)=>{
 const f=await fixture(t);await f.create("knowledge:raw-inspection","knowledge",{value:1},"global",semantics);
 const db=await openWriteDatabase(f.database);
 try {
  const row=db.prepare("SELECT content_json FROM records WHERE id=?").get("knowledge:raw-inspection");
  const stored=JSON.parse(row.content_json);delete stored._lodestar.semantics;
  admittedTransaction(db,()=>db.prepare("UPDATE records SET content_json=? WHERE id=?").run(JSON.stringify(stored),"knowledge:raw-inspection"));
 }
 finally {db.close();}
 const raw=await f.cli(["get","knowledge:raw-inspection","--raw"]);assert.equal(raw.code,0,JSON.stringify(raw.value));
 assert.ok(raw.value.data.raw_record);
});

for (const malformed of [
 { project: { invalid: true }, checkout: null },
 { project: "project:example", checkout: { invalid: true } },
]) {
 test(`malformed applicability ${JSON.stringify(malformed)} leaves raw and history readable without a write basis`,async(t)=>{
  const f=await fixture(t);const id="knowledge:malformed-applicability";
  await f.create(id,"knowledge",{value:1},"global",semantics);
  const db=await openWriteDatabase(f.database);
  try {
   const row=db.prepare("SELECT content_json FROM records WHERE id=?").get(id);
   const stored=JSON.parse(row.content_json);
   stored._lodestar.semantics.applicability=malformed;
   admittedTransaction(db,()=>db.prepare("UPDATE records SET content_json=? WHERE id=?")
    .run(JSON.stringify(stored),id));
  } finally {db.close();}
  for (const flag of ["--raw","--history"]) {
   const read=await f.cli(["get",id,flag]);
   assert.equal(read.code,0,JSON.stringify(read.value));
   assert.equal(read.value.data.write_basis,null);
   assert.equal(read.value.data[flag==="--raw"?"raw_record":"id"].id??read.value.data.id,id);
  }
 });
}
