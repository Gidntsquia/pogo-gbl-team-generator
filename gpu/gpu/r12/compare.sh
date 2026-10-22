#!/usr/bin/env bash
# Round 12 R10/R11: checkpoint identity of every run of session $SESS (default s6) against the default of the same pass -> out/gpu/r12/det-$SESS.txt
cd /home/jaxon/files/pogo-gbl-team-generator
for d in out/evolve-gpu8-r10-${SESS:-s6}-*-[123]; do
  n=$(basename "$d"); n=${n#evolve-gpu8-}; v=${n#r10-${SESS:-s6}-}; v=${v%-*}; i=${n##*-}
  [ "$v" = default ] && continue
  r=$(node -e "import('./gpu/gpu/study/runs.mjs').then((m) => { const c = m.compareRuns('out/evolve-gpu8-r10-${SESS:-s6}-default-$i', '$d'); console.log(c.same ? 'IDENTICAL (' + c.files + ' checkpoints, timing fields ignored)' : 'DIFFER: ' + c.differ.length + ' of ' + c.files + ' checkpoints'); })")
  echo "$n vs r10-${SESS:-s6}-default-$i: $r"
done | sort
