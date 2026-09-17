'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { Language } from '@/lib/roofline';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

type EditorStatus = 'loading' | 'ready' | 'fallback';

interface CodeEditorProps {
  value: string;
  language: Language;
  onChange: (next: string) => void;
  readOnly?: boolean;
}

/**
 * Monaco is loaded on the client only. @monaco-editor/react fetches the editor
 * bundle from jsDelivr on first load, so an offline browser falls back to a
 * plain textarea instead of an empty panel.
 */
export default function CodeEditor({ value, language, onChange, readOnly = false }: CodeEditorProps) {
  const [status, setStatus] = useState<EditorStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setStatus(current => (current === 'loading' ? 'fallback' : current));
    }, 8000);
    import('@monaco-editor/react')
      .then(module => module.loader.init())
      .then(() => {
        clearTimeout(timer);
        if (!cancelled) setStatus('ready');
      })
      .catch(() => {
        clearTimeout(timer);
        if (!cancelled) setStatus('fallback');
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-slate-800 bg-[#0d1117]">
      {status === 'ready' ? (
        <MonacoEditor
          height="100%"
          language="python"
          theme="vs-dark"
          value={value}
          onChange={next => onChange(next ?? '')}
          loading={<EditorPlaceholder text="Loading Monaco editor..." />}
          options={{
            readOnly,
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            renderWhitespace: 'selection',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
          }}
        />
      ) : (
        <textarea
          className="kf-mono h-full w-full resize-none bg-[#0d1117] p-3 text-[13px] leading-5 text-slate-200 outline-none"
          spellCheck={false}
          value={value}
          readOnly={readOnly}
          onChange={event => onChange(event.target.value)}
          aria-label="Kernel source"
        />
      )}
      <p className="pointer-events-none absolute bottom-1 right-2 rounded bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-400">
        {status === 'ready'
          ? `${language === 'triton' ? 'Triton (Python grammar)' : language === 'pytorch' ? 'Python + torch' : 'Python'} - Monaco`
          : status === 'loading'
            ? 'Plain editor - Monaco loading'
            : 'Plain editor - Monaco unavailable (offline?)'}
      </p>
    </div>
  );
}

function EditorPlaceholder({ text }: { text: string }) {
  return <p className="p-3 text-sm text-slate-400">{text}</p>;
}
