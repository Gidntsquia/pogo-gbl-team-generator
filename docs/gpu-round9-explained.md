# GPU round 9, explained 🧭

Five ideas behind the round-8 and round-9 GPU results, one picture each.

Numbers come from the study page `out/gpu-study.html` and its round-7/8 detail pages (`out/gpu/study/detail/`), branch `gpu`.

## Island halving costs 5.4 s per generation

![Round 7 warm s/gen: one pool 12.20 and 12.05, island halving 17.64 and 17.51](gpu-r9-island.png)

A halving round lets every team fight a few opponents, then cuts the bottom half.

Island halving splits teams into islands and runs each island's rounds in one launch. One pool keeps teams together.

Each round waits for its longest battle while the other threads sit idle.

## Battle state sits in slow memory

![Battle state lives in GPU main memory and reaches the SM through L1 and L2](gpu-r9-memory.png)

Each battle keeps about 39,000 bytes of state in local memory: teams, HP, energy and its lookahead.

Local memory is GPU main memory, reached through the L1 and L2 caches.

Nsight Compute, NVIDIA's profiler, shows this is nearly all L1 traffic. Half of all warp cycles wait for it.

Round 8's compact state packs fields into 8 and 16 bits. It saved 0.5 s per generation in a 3-pass A/B.

## Why the scheduling ideas ran slower

![Six round-8 scheduling ideas each added 2.0 to 7.3 s per generation](gpu-r9-scheduling.png)

Two streams overlap host (CPU-side) work with the GPU. CPU share auto moves some battles to the CPU.

The smaller pool shrinks look-ahead memory and re-runs battles that overflow it, one at a time.

The queue kernel hands threads whole battles from a list. Lockstep runs one slice of every battle per launch.

None makes a battle shorter, and a launch still waits for its longest one. Why each added time was not measured.

## The tail, and why it is the target

![Busy SMs over a 10k-battle launch: all 68 busy, then a slow drop after half the battles finish](gpu-r9-tail.png)

The tail is the end of a launch, from when half its battles are done until the last one ends.

In it the GPU's 68 cores (SMs) run out of work one by one.

Round 9 filled that idle time with the next round's battles. The SMs stayed busier, but the launch still ends
with its longest battle.

## Reading warm s/gen and its noise

![Round 9 A/B: one dot per run for default, tail filler and certain feed](gpu-r9-noise.png)

Warm s/gen: mean seconds per generation once the share of battles answered from saved results has levelled off.

The same run repeated gives a slightly different time. The spread, slowest minus fastest, is that noise.

A change counts only if it moves the mean by more than both spreads.
