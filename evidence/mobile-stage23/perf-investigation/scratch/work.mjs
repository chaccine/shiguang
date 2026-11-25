import { createHash } from "node:crypto";

export const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
export const idHash = ids => hash(ids.slice().sort().join("\n"));
export const queries = ["homeSummary", "reunionPreview", "reunionPage", "favoritesFirst",
  "photosFirst", "years", "yearRoomFirst", "reshuffle"];
export const keys = queries.flatMap(name => ["domain." + name, "adapter." + name])
  .concat(["adapter.photosNext.asc", "adapter.photosNext.desc"]);

export function inputFacts(bytes) {
  const state = JSON.parse(bytes);
  const rows = state.records;
  const formal = rows.flatMap(row => row.formal ? [row.formal] : []);
  const uses = formal.flatMap(snap => snap.photos);
  const anniversary = rows.filter(row => row.formal?.eventDate === "2024-11-12");
  return {
    utf8Bytes: Buffer.byteLength(bytes), sha256: hash(bytes), version: state.version,
    schema: state.schemaVersion, rows: rows.length, active: rows.filter(r => r.status === "active").length,
    formal: formal.length, drafts: rows.filter(r => r.draft !== null).length, photoUses: uses.length,
    referencedAssetIds: new Set(uses.map(p => p.assetId)).size, assetEntries: Object.keys(state.assets).length,
    favorites: rows.filter(r => r.favorite).length, hidden: rows.filter(r => r.museumHidden).length,
    anniversary2024: anniversary.length, hiddenAnniversary: anniversary.filter(r => r.museumHidden).length,
    eligibleIdSetSha256: idHash(anniversary.filter(r => !r.museumHidden).map(r => r.recordId))
  };
}
