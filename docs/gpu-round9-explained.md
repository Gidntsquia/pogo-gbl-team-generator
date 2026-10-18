# GPU round 9, explained 🧭

Five ideas behind the round-8 and round-9 GPU results, one picture each.

Numbers come from the study page `out/gpu-study.html` and its round-7/8 detail pages (`out/gpu/study/detail/`), branch `gpu`.

## Island halving costs 5.4 s per generation

![Round 7 warm s/gen: one pool 12.20 and 12.05, island halving 17.64 and 17.51](gpu-r9-island.png)

Island halving runs each island's halving rounds inside one launch, one round after another.

A round's battles run side by side. The next round starts only when the longest one ends.

All other threads wait at that line, once per round and island.

## Battle state belongs on-chip

![Battle state lives in GPU main memory and reaches the SM through L1 and L2](gpu-r9-memory.png)

Each battle keeps about 39,000 bytes of state in local memory: teams, HP, energy and its lookahead.

Local memory is GPU main memory, reached through the L1 and L2 caches.

Nsight Compute, NVIDIA's profiler, shows this is nearly all L1 traffic. Half of all warp cycles wait for it.

Round 8's compact state packs fields into 8 and 16 bits. It saved 0.5 s per generation in a 3-pass A/B.

## Why the scheduling ideas ran slower

![Six round-8 scheduling ideas each added 2.0 to 7.3 s per generation](gpu-r9-scheduling.png)

Two streams overlap host work with the GPU. The smaller pool uses a smaller search pool, with a rare re-run.

A queue or lockstep changes how battles reach threads. CPU sharing moves some to the CPU.

None makes a battle shorter: half of all warp cycles wait on memory, and a launch waits for its longest battle.

Why each one added time was not measured one by one.

## The tail, and why it is the target

![Busy SMs over a 10k-battle launch: all 68 busy, then a slow drop after half the battles finish](gpu-r9-tail.png)

The tail is the end of a launch, from when half its battles are done until the last one ends.

In it the GPU's 68 cores (SMs) run out of work one by one.

Round 9 filled that idle time with the next round's battles. The SMs stayed busier, but the launch still ends
with its longest battle.

## Reading warm s/gen and its noise

![Round 9 A/B: one dot per run for default, tail filler and certain feed](gpu-r9-noise.png)

Warm s/gen: mean seconds per generation once the cache hit rate has levelled off; slower early generations are left out.

The same run repeated gives a slightly different time. The spread, slowest minus fastest, is that noise.

A change counts only if it moves the mean by more than both spreads.
