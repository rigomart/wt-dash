import { expect, test } from 'bun:test';
import { readComparisonBase } from '../src/core/base';
import type { CommandRunner } from '../src/core/types';
const ok=(stdout='')=>({stdout,stderr:'',exitCode:0});
test.each([['0\t2','origin/main'],['0\t0','main'],['1\t2','main'],['2\t0','main']])('comparison base for divergence %s is %s',async(counts,want)=>{
 const runner:CommandRunner=async(_command,args)=>ok(args.includes('rev-parse')?'refs/remotes/origin/main\n':counts);
 expect(await readComparisonBase('/repo','main',runner)).toBe(want);
});
test('comparison base falls back to default branch without upstream',async()=>{
 expect(await readComparisonBase('/repo','main',async()=>({...ok(),exitCode:1}))).toBe('main');
});
