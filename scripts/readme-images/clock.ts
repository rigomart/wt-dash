/**
 * Preloaded into the app (through BUN_OPTIONS) for the README images: its clock starts at WT_DASH_README_NOW and
 * runs from there, so ages and the scan time read the same on every rebuild.
 */
const RealDate = Date;
const offset = RealDate.parse(process.env.WT_DASH_README_NOW ?? "") - RealDate.now();
if (Number.isNaN(offset)) throw new Error("WT_DASH_README_NOW must be a date.");

class PinnedDate extends RealDate {
  constructor(...args: [] | [string | number | Date]) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(args[0]);
  }

  static override now(): number {
    return RealDate.now() + offset;
  }
}

globalThis.Date = PinnedDate as DateConstructor;
