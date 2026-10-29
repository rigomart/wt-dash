import { expect, test } from "bun:test";
import { listingOrder } from "../../src/core/scan/order";

test("repos are listed most worktrees first, with the one that took the most space last time second", () => {
  const linked = (count: number, paths: string[] = []) => ({ count, paths });
  const sizes: Record<string, number> = { "/trees/h1": 900, "/trees/h2": 900, "/trees/b1": 50 };
  const { order, first } = listingOrder(
    [
      { path: "/r/alpha", linked: linked(2) },
      { path: "/r/big", linked: linked(9, ["/trees/b1"]) },
      { path: "/r/heavy", linked: linked(2, ["/trees/h1", "/trees/h2"]) },
      { path: "/r/gone", linked: null },
      { path: "/r/mid", linked: linked(5) },
    ],
    (path) => sizes[path] ?? null,
  );
  expect(order).toEqual(["/r/big", "/r/heavy", "/r/mid", "/r/alpha", "/r/gone"]);
  expect([...first]).toEqual(["/r/big", "/r/heavy"]);
  const unmeasured = listingOrder(
    [
      { path: "/r/alpha", linked: linked(2) },
      { path: "/r/big", linked: linked(9) },
    ],
    () => null,
  );
  expect(unmeasured.order).toEqual(["/r/big", "/r/alpha"]);
  expect([...unmeasured.first]).toEqual(["/r/big"]);
});
