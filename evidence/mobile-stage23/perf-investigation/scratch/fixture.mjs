// Input construction and fingerprint only. This process does not execute a query or test.
import { syntheticRows, photos, stateWithRows } from "../../../../tests/support/museum.ts";
import { inputFacts } from "./work.mjs";
const rows = syntheticRows(5000);
rows.forEach((row, i) => {
  photos(row, 1);
  if (i % 100 === 0) row.formal.eventDate = "2024-11-12";
  row.favorite = i % 5 === 0;
  row.museumHidden = i % 37 === 0;
});
console.log(JSON.stringify(inputFacts(JSON.stringify(stateWithRows(rows))), null, 2));
