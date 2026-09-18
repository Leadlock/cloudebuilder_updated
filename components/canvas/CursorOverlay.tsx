import React, { useEffect, useState } from 'react';
import { MousePointer2 } from 'lucide-react';
import { useStore } from 'reactflow';
import clsx from 'clsx';

interface Cursor {
  id: string;
  name: string;
  color: string;
  bg: string;
  x: number;
  y: number;
}

const FAKE_USERS = [
  { id: 'u1', name: 'Alice (DevOps)', color: 'text-fuchsia-500', bg: 'bg-fuchsia-500' },
  { id: 'u2', name: 'Bob (Security)', color: 'text-amber-500', bg: 'bg-amber-500' },
];

export default function CursorOverlay() {
  const transform = useStore((s) => s.transform);
  const zoom = transform[2] ?? 1;

  const [cursors, setCursors] = useState<Cursor[]>(() => {
    if (typeof window === 'undefined') return [];
    return FAKE_USERS.map(u => ({
      ...u,
      x: Math.random() * window.innerWidth * 0.8,
      y: Math.random() * window.innerHeight * 0.8,
    }));
  });

  useEffect(() => {
    // Simulate movement
    const interval = setInterval(() => {
      setCursors((prevCursors) =>
        prevCursors.map((c) => ({
          ...c,
          x: c.x + (Math.random() - 0.5) * 50,
          y: c.y + (Math.random() - 0.5) * 50,
        }))
      );
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none z-50 overflow-hidden">
      {cursors.map(c => (
        <div
          key={c.id}
          className="absolute transition-all duration-1000 ease-linear"
          style={{
            transform: `translate(${c.x * zoom + transform[0]}px, ${c.y * zoom + transform[1]}px)`,
          }}
        >
          <MousePointer2 className={clsx('w-5 h-5 drop-shadow-md fill-current', c.color)} />
          <div className={clsx('absolute left-4 top-4 px-2 py-0.5 rounded text-[10px] font-bold text-white shadow-md whitespace-nowrap', c.bg)}>
            {c.name}
          </div>
        </div>
      ))}
    </div>
  );
}
