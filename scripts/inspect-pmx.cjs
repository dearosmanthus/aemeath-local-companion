// Read-only inspection: no model files are written, converted, or uploaded.
const fs = require('node:fs');
const path = require('node:path');
const { MMDLoader } = require('three-stdlib');
const root = path.resolve(__dirname, '..');
const model = path.join(root, 'wallpaper/assets/models/aemeath-pmx/aemeath.pmx');
const buffer = fs.readFileSync(model);
const loader = new MMDLoader();
const data = loader._getParser().parsePmx(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), true);
const groupSupport = (morph) => morph.type === 1 || (morph.type === 0 && morph.elements.some(e => data.morphs[e.index]?.type === 1));
const boneWeights = new Map();
for (const vertex of data.vertices) for (let slot=0;slot<vertex.skinIndices.length;slot++) {
  if ((vertex.skinWeights[slot] || 0) > 0) boneWeights.set(vertex.skinIndices[slot], (boneWeights.get(vertex.skinIndices[slot]) || 0) + 1);
}
const report = {
  metadata: data.metadata,
  bones: data.bones.map((b,i) => ({index:i,name:b.name,englishName:b.englishName,parentIndex:b.parentIndex,parentName:data.bones[b.parentIndex]?.name,position:b.position,weightedVertices:boneWeights.get(i)||0,grant:b.grant,ik:b.ik,flag:b.flag,transformationClass:b.transformationClass})),
  morphs: data.morphs.map((m,i) => ({index:i,name:m.name,englishName:m.englishName,type:m.type,panel:m.panel,elementCount:m.elementCount,vertexMorphInLoader:groupSupport(m),elements:m.type===1?undefined:m.elements.map(e=>({...e,refName:m.type===0?data.morphs[e.index]?.name:m.type===2?data.bones[e.index]?.name:undefined}))})),
  materials: data.materials,
  textures: data.textures.map(p=>({path:p,exists:fs.existsSync(path.resolve(path.dirname(model), p.replaceAll('\\','/')))})),
  rigidBodyCount:data.rigidBodies?.length,
  constraintCount:data.constraints?.length,
};
report.summary = {
  modelName:data.metadata.modelName,
  vertexCount:data.metadata.vertexCount,
  triangleCount:data.metadata.faceCount,
  materialCount:data.metadata.materialCount,
  boneCount:data.metadata.boneCount,
  morphCount:data.metadata.morphCount,
  morphTypes:report.morphs.reduce((counts,morph)=>(counts[morph.type]=(counts[morph.type]||0)+1,counts),{}),
  missingTextures:report.textures.filter(texture=>!texture.exists),
  morphCpuMiB:data.metadata.morphCount*data.metadata.vertexCount*3*4/1024/1024,
  morphGpuMiBAt16384:Math.ceil(data.metadata.vertexCount/16384)*16384*data.metadata.morphCount*4*4/1024/1024,
  rigidBodyCount:report.rigidBodyCount,
  constraintCount:report.constraintCount,
  boneMap:Object.fromEntries(['センター','上半身','上半身2','上半身1','首','頭','左肩','右肩','左腕','右腕','左ひじ','右ひじ','左手首','右手首','左目','右目'].map(name=>[name,report.bones.find(bone=>bone.name===name)?.index])),
  usefulVertexMorphs:report.morphs.filter(morph=>['まばたき','笑い','にこり','笑い目','びっくり','あ','い','う','え','お','にやり','口角上げ','照れ','困る','上','ウィンク','ウィンク右'].includes(morph.name)).map(({index,name,type,elementCount})=>({index,name,type,elementCount})),
};
module.exports = report;
if (require.main === module) {
  const section = process.argv[2] || 'summary';
  console.log(JSON.stringify(report[section], null, 2));
}
