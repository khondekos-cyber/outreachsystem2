"use client";
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

// Same stage order + colors as the Pipeline board, so the dashboard summary
// reads as the same system rather than a second, slightly different one.
const STAGES = ["Outreach Sent", "Replied", "AI Qualifying", "Interested / Demo", "Booked / Won", "Lost / Ghosted"];
const STAGE_COLOR: Record<string, string> = {
  "Outreach Sent": "bg-slate-300",
  "Replied": "bg-blue-400",
  "AI Qualifying": "bg-amber-400",
  "Interested / Demo": "bg-indigo-500",
  "Booked / Won": "bg-emerald-500",
  "Lost / Ghosted": "bg-red-300",
};

export default function Dashboard() {
  const [stats, setStats] = useState({ total: 0, active: 0 });
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const fetchStats = async () => {
      const { data } = await supabase.from('leads').select('id, ai_active, status');
      if (data) {
        setStats({ total: data.length, active: data.filter(l => l.ai_active).length });

        const counts: Record<string, number> = {};
        STAGES.forEach(s => { counts[s] = 0; });
        data.forEach(l => {
          if (l.status && counts[l.status] !== undefined) counts[l.status]++;
        });
        setStageCounts(counts);
      }
    };
    fetchStats();
    const sub = supabase.channel('stats').on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => fetchStats()).subscribe();
    return () => { supabase.removeChannel(sub); };
  }, []);

  const maxCount = Math.max(1, ...Object.values(stageCounts));

  return (
    <div className="p-6 sm:p-10 pb-24 sm:pb-10 bg-[#f8fafc] min-h-screen">
      <h1 className="text-3xl sm:text-4xl font-black text-slate-800 italic uppercase tracking-tighter">Main Dashboard</h1>
      <p className="text-slate-400 font-bold text-sm tracking-widest mt-2 uppercase">System Source of Truth</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-10 mt-8 sm:mt-12">
        <div className="bg-white p-6 sm:p-10 rounded-[32px] sm:rounded-[40px] border shadow-sm flex flex-col justify-between h-40 sm:h-52">
           <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Total Prospects</span>
           <span className="text-5xl sm:text-7xl font-black text-indigo-600 italic leading-none">{stats.total}</span>
        </div>
        <div className="bg-white p-6 sm:p-10 rounded-[32px] sm:rounded-[40px] border shadow-sm flex flex-col justify-between h-40 sm:h-52">
           <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">AI Agents Active</span>
           <span className="text-5xl sm:text-7xl font-black text-emerald-500 italic leading-none">{stats.active}</span>
        </div>
      </div>

      {/* PIPELINE STAGE SUMMARY */}
      <div className="mt-6 sm:mt-10 bg-white rounded-[32px] sm:rounded-[40px] border shadow-sm p-6 sm:p-10">
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Pipeline Overview</span>

        <div className="mt-6 space-y-4">
          {STAGES.map(stage => {
            const count = stageCounts[stage] || 0;
            const widthPct = Math.round((count / maxCount) * 100);
            return (
              <div key={stage} className="flex items-center gap-3 sm:gap-4">
                <div className="w-32 sm:w-44 flex-shrink-0 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STAGE_COLOR[stage]}`} />
                  <span className="text-[10px] sm:text-[11px] font-black text-slate-500 uppercase tracking-wider truncate">{stage}</span>
                </div>
                <div className="flex-1 h-2.5 bg-slate-50 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${STAGE_COLOR[stage]} transition-all duration-500`}
                    style={{ width: `${count > 0 ? Math.max(widthPct, 4) : 0}%` }}
                  />
                </div>
                <span className="w-8 flex-shrink-0 text-right text-sm font-black text-slate-800 italic">{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}