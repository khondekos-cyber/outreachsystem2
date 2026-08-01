"use client";
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import ActionPipeline from '@/components/dashboard/ActionPipeline';
import LeadModal from '@/components/dashboard/LeadModal';
import { Bot, Flame, Target, Phone, RefreshCw } from 'lucide-react';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export default function PipelinePage() {
  const [leads, setLeads] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    fetchLeads();
    const sub = supabase.channel('pipeline').on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => fetchLeads()).subscribe();
    return () => { supabase.removeChannel(sub); };
  }, []);

  // Keep an open LeadModal fresh: `selected` is a snapshot taken at click time,
  // so without this it never reflects new data (sales_process, pain_points, etc.)
  // that arrives via the realtime subscription above while the modal is open.
  useEffect(() => {
    if (!selected) return;
    const updated = leads.find(l => l.id === selected.id);
    if (updated && updated !== selected) setSelected(updated);
  }, [leads]);

  const fetchLeads = async () => {
    setSyncing(true);
    const { data } = await supabase.from('leads').select('*').order('last_message_at', { ascending: false });
    if (data) setLeads(data);
    setSyncing(false);
  };

  const urgent = leads.filter(l => (l.lead_score || 0) >= 90).slice(0, 4);

  return (
    <div className="flex flex-col h-screen bg-[#f8fafc] overflow-hidden">
      {/* Tightened Header */}
      <header className="px-6 py-4 flex justify-between items-center bg-white border-b">
        <div>
          <h1 className="text-xl font-black text-slate-800 italic uppercase tracking-tighter">Action Pipeline</h1>
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-[0.2em]">{leads.length} PROSPECTS LIVE</p>
        </div>
        <button onClick={fetchLeads} className={`p-2 rounded-full hover:bg-slate-50 border transition-all ${syncing ? 'animate-spin' : ''}`}>
            <RefreshCw size={16}/>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto pb-20 sm:pb-0">
        {/* Compressed Urgent Banner */}
        {urgent.length > 0 && (
            <div className="px-6 mt-4">
                <div className="bg-[#fff1f2] border border-red-100 rounded-2xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <Flame size={14} className="text-red-500" fill="currentColor" />
                        <h3 className="font-black text-red-600 uppercase italic text-[10px] tracking-widest">Needs Immediate Action</h3>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {urgent.map(l => (
                            <div key={l.id} onClick={() => setSelected(l)} className="bg-white p-3 rounded-xl border border-red-50 flex items-center gap-3 cursor-pointer hover:shadow-md transition-all">
                                <Phone size={14} className="text-red-500" />
                                <p className="text-[10px] font-black text-slate-800 truncate uppercase italic">{l.name}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        )}

        {/* Small Stat Boxes */}
        <div className="px-6 mt-4 grid grid-cols-3 gap-4">
            <StatBox count={leads.filter(l => l.ai_active).length} label="AI HANDLING" icon={<Bot size={20}/>} color="indigo" />
            <StatBox count={leads.filter(l => (l.lead_score || 0) >= 70).length} label="QUALIFIED" icon={<Flame size={20}/>} color="red" />
            <StatBox count={leads.filter(l => l.status === 'Interested / Demo').length} label="DEMO GOAL" icon={<Target size={20}/>} color="emerald" />
        </div>

        {/* The Pipeline Board */}
        <div className="mt-4">
            <ActionPipeline leads={leads} onLeadClick={setSelected} />
        </div>
      </div>

      {selected && <LeadModal lead={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function StatBox({ count, label, icon, color }: any) {
    const colors: any = { indigo: 'text-indigo-600 bg-indigo-50', red: 'text-red-500 bg-red-50', emerald: 'text-emerald-600 bg-emerald-50' };
    return (
        <div className="bg-white border border-slate-100 p-4 rounded-2xl flex items-center gap-4 shadow-sm">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-inner ${colors[color]}`}>{icon}</div>
            <div>
                <p className="text-xl font-black text-slate-800 italic leading-none">{count}</p>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">{label}</p>
            </div>
        </div>
    );
}