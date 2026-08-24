/**
 * Pure NSET node-id parsing and mechanical fixed/load intersection.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  assertMechanicalFixedAndLoadNodeDisjoint,
  buildBuckleDeck,
  buildCoupledThermalDeck,
  buildCreepDeck,
  buildDeck,
  SolveError,
} from "../src/api/ccx.ts";
import { parseNsetNodeIds } from "../src/api/gmsh.ts";

Deno.test("parseNsetNodeIds reads wrapped lists and GENERATE form", () => {
  const wrapped = parseNsetNodeIds(`
*NSET,NSET=FIXED
1, 2,
3, 4
*NSET, NSET=LOADED
10, 11
`);
  assertEquals([...wrapped.FIXED].sort((a, b) => a - b), [1, 2, 3, 4]);
  assertEquals([...wrapped.LOADED].sort((a, b) => a - b), [10, 11]);

  const generated = parseNsetNodeIds(`
*NSET, NSET=FIXED, GENERATE
1, 5
*NSET,NSET=LOADED,GENERATE
10, 16, 2
`);
  assertEquals([...generated.FIXED].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assertEquals([...generated.LOADED].sort((a, b) => a - b), [10, 12, 14, 16]);
});

Deno.test("disjoint mechanical NSETs are accepted; intersecting node ids are rejected", () => {
  const disjoint = `
*NSET,NSET=FIXED
1, 2, 3
*NSET,NSET=LOADED
4, 5, 6
`;
  assertMechanicalFixedAndLoadNodeDisjoint(disjoint, ["FIXED"], ["LOADED"]);

  const intersecting = `
*NSET, NSET=FIXED
1, 2,
3
*NSET, NSET=LOADED
3, 4
`;
  assertThrows(
    () =>
      assertMechanicalFixedAndLoadNodeDisjoint(
        intersecting,
        ["FIXED"],
        ["LOADED"],
      ),
    SolveError,
    "share node 3",
  );

  const generatedOverlap = `
*NSET, NSET=FIXED, GENERATE
1, 5
*NSET, NSET=LOADED, GENERATE
5, 8
`;
  assertThrows(
    () =>
      assertMechanicalFixedAndLoadNodeDisjoint(
        generatedOverlap,
        ["FIXED"],
        ["LOADED"],
      ),
    SolveError,
    "share node 5",
  );
});

Deno.test("repeated GENERATE data lines are independent ranges and union", () => {
  const parsed = parseNsetNodeIds(`
*NSET, NSET=FIXED, GENERATE
1, 3
10, 14, 2
`);
  assertEquals([...parsed.FIXED].sort((a, b) => a - b), [1, 2, 3, 10, 12, 14]);

  const disjoint = `
*NSET, NSET=FIXED, GENERATE
1, 3
10, 12
*NSET, NSET=LOADED, GENERATE
4, 6
20, 22
`;
  assertMechanicalFixedAndLoadNodeDisjoint(disjoint, ["FIXED"], ["LOADED"]);
});

Deno.test("lowercase NSET headers and names lookup through the mechanical disjoint guard", () => {
  const disjoint = `
*nset, nset=fixed, generate
1, 4
*nset, nset=loaded, generate
5, 8
`;
  assertMechanicalFixedAndLoadNodeDisjoint(disjoint, ["FIXED"], ["loaded"]);

  const overlap = `
*nset, nset=fixed, generate
1, 5
*NSET, NSET=loaded
5, 6
`;
  assertThrows(
    () =>
      assertMechanicalFixedAndLoadNodeDisjoint(overlap, ["fixed"], ["LOADED"]),
    SolveError,
    "share node 5",
  );
});

Deno.test("builders still lower a historical overlapping fixed/load NSET deck", () => {
  const inpText = "*NSET,NSET=FIXED\n1, 2\n*NSET,NSET=LOADED\n2, 3\n";
  assertThrows(
    () =>
      assertMechanicalFixedAndLoadNodeDisjoint(inpText, ["FIXED"], ["LOADED"]),
    SolveError,
    "share node 2",
  );
  const overlapping = {
    inpText,
    maxNodeId: 3,
    material: { eMpa: 70000, nu: 0.33 },
    fixed: ["FIXED"],
    loads: [{
      selection: "LOADED" as const,
      totalForceN: [0, 0, -10] as [
        number,
        number,
        number,
      ],
    }],
    nodesPerSet: { FIXED: 2, LOADED: 2 },
  };
  const staticDeck = buildDeck(overlapping);
  assertEquals(staticDeck.includes("FIXED,1,3"), true);
  assertEquals(staticDeck.includes("LOADED,3,"), true);
  const buckleDeck = buildBuckleDeck({ ...overlapping, nModes: 1 });
  assertEquals(buckleDeck.includes("*BUCKLE"), true);
  const creepDeck = buildCreepDeck({
    ...overlapping,
    nortonA: 1e-10,
    nortonN: 3,
    durationS: 100,
    initialTimeDtS: 10,
  });
  assertEquals(creepDeck.includes("*VISCO"), true);
  const thermalDeck = buildCoupledThermalDeck({
    ...overlapping,
    conductivityWmK: 167,
    expansionPerK: 23.6e-6,
    referenceTemperatureC: 20,
    thermalBCs: [{ selection: "LOADED", temperatureC: 200 }],
  });
  assertEquals(thermalDeck.includes("*COUPLED"), true);
  assertEquals(thermalDeck.includes("LOADED,3,"), true);
});

Deno.test("coupled thermal does not treat a thermal BC as a mechanical load overlap", () => {
  const deck = buildCoupledThermalDeck({
    inpText: "*NSET,NSET=FIXED\n1, 2\n*NSET,NSET=HOT\n1, 2\n",
    maxNodeId: 2,
    material: { eMpa: 70000, nu: 0.33 },
    conductivityWmK: 167,
    expansionPerK: 23.6e-6,
    referenceTemperatureC: 20,
    fixed: ["FIXED"],
    thermalBCs: [{ selection: "HOT", temperatureC: 200 }],
    loads: [],
    nodesPerSet: { FIXED: 2, HOT: 2 },
  });
  assertEquals(deck.includes("FIXED,1,3"), true);
  assertEquals(deck.includes("HOT,11,11,200"), true);
});
