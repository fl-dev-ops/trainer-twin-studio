import assert from "node:assert/strict";
import test from "node:test";
import { computePCA3D } from "./org-knowledge";

test("computePCA3D calculates 3D PCA coordinates for high dimensional embeddings", () => {
  const mockEmbeddings = [
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];

  const projected = computePCA3D(mockEmbeddings, 25);
  assert.equal(projected.length, 5);
  for (const pt of projected) {
    assert.equal(pt.length, 3);
    assert.equal(typeof pt[0], "number");
    assert.equal(typeof pt[1], "number");
    assert.equal(typeof pt[2], "number");
    assert.ok(Math.abs(pt[0]) <= 25.01);
    assert.ok(Math.abs(pt[1]) <= 25.01);
    assert.ok(Math.abs(pt[2]) <= 25.01);
  }
});

test("computePCA3D handles empty or tiny inputs gracefully", () => {
  assert.deepEqual(computePCA3D([]), []);
  const single = computePCA3D([[1, 2, 3]]);
  assert.equal(single.length, 1);
  assert.equal(single[0].length, 3);
});
