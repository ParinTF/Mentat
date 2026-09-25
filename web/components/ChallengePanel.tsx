'use client';

import { useState } from 'react';
import { BookOpen, ListTree } from 'lucide-react';
import { CHALLENGE_CATALOG, CONCEPT_TREE, challengesForConcept } from '@/lib/catalog';
import type { ChallengeEntry } from '@/lib/catalog';

interface ChallengePanelProps {
  onLoadStarter: (code: string, language: ChallengeEntry['language'], device: ChallengeEntry['device']) => void;
  disabled?: boolean;
  disabledReason?: string;
}

type Tab = 'challenges' | 'concepts';

const METRIC_LABEL: Record<ChallengeEntry['target_metric'], string> = {
  speedup: 'speedup',
  bandwidth_efficiency: 'bandwidth efficiency',
  compute_efficiency: 'compute efficiency',
};

export default function ChallengePanel({ onLoadStarter, disabled = false, disabledReason }: ChallengePanelProps) {
  const [tab, setTab] = useState<Tab>('challenges');

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-[#0b1120]">
      <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <button
          type="button"
          onClick={() => setTab('challenges')}
          className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${tab === 'challenges' ? 'bg-sky-500/10 text-sky-200' : 'text-slate-400 hover:text-slate-200'}`}
        >
          <ListTree size={13} /> Challenges ({CHALLENGE_CATALOG.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('concepts')}
          className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${tab === 'concepts' ? 'bg-sky-500/10 text-sky-200' : 'text-slate-400 hover:text-slate-200'}`}
        >
          <BookOpen size={13} /> Concept tree
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'challenges' ? (
          <ul className="flex flex-col gap-2">
            {CHALLENGE_CATALOG.map(entry => (
              <li key={entry.slug} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                <p className="text-xs font-semibold text-slate-100">{entry.title}</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {`concept: ${entry.concept} | ${entry.language} on ${entry.device} | target: ${METRIC_LABEL[entry.target_metric]} >= ${entry.threshold}`}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {`theory: ${entry.theory}(${Object.entries(entry.theory_params).map(([key, value]) => `${key}=${value}`).join(', ')}) - FLOPs/bytes computed by the server, so declared numbers cannot pass`}
                </p>
                <button
                  type="button"
                  onClick={() => onLoadStarter(entry.starter_code, entry.language, entry.device)}
                  disabled={disabled}
                  className="mt-2 rounded-lg border border-sky-500/50 bg-sky-500/10 px-2 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {disabled ? disabledReason ?? 'Unavailable on this worker' : 'Load starter into editor'}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="flex flex-col gap-2">
            {CONCEPT_TREE.map(node => (
              <li key={node.slug} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                <p className="text-xs font-semibold text-slate-100">{node.title}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-400">{node.description}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {node.prerequisites.length === 0
                    ? 'no prerequisites'
                    : `requires: ${node.prerequisites.map(slug => CONCEPT_TREE.find(item => item.slug === slug)?.title ?? slug).join(', ')}`}
                </p>
                <p className="mt-1 text-[11px] text-sky-300/80">
                  {challengesForConcept(node.slug).map(entry => entry.title).join(' | ') || 'no challenge linked yet'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}