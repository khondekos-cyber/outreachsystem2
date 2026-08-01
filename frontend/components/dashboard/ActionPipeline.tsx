"use client";
import { useState } from 'react';
import { Flame, MapPin } from 'lucide-react';

const COLS = ["Outreach Sent", "Replied", "AI Qualifying", "Interested / Demo", "Booked / Won", "Lost / Ghosted"];

// Twitter-style relative time: "now", "5m", "2h", "3d"
function timeAgo(dateStr?: string) {
  if (!dateStr) return "";
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

const STATUS_DOT: Record<string, string> = {
  "Outreach Sent": "bg-slate-300",
  "Replied": "bg-blue-400",
  "AI Qualifying": "bg-amber-400",
  "Interested / Demo": "bg-indigo-500",
  "Booked / Won": "bg-emerald-500",
  "Lost / Ghosted": "bg-red-300",
};

export default function ActionPipeline({ leads, onLeadClick }: any) {
  const [activeTab, setActiveTab] = useState<string>("All");
  const tabs = ["All", ...COLS];
  const feedLeads = (activeTab === "All" ? leads : leads.filter((l: any) => l.status === activeTab))
    .slice()
    .sort((a: any, b: any) => new Date(b.last_message_at || 0).getTime() - new Date(a.last_message_at || 0).getTime());

  return (
    <>
      {/* ===== DESKTOP: kanban board ===== */}
      <div className="hidden sm:flex gap-4 px-6 pb-10 overflow-x-auto">
        {COLS.map(col => {
          const columnLeads = leads.filter((l: any) => l.status === col);

          return (
            <div key={col} className="flex-shrink-0 w-72">
              <div className="flex items-center justify-between mb-4 px-2">
                <h3 className="font-black text-slate-400 text-[9px] uppercase tracking-[0.3em]">{col}</h3>
                <span className="bg-white text-slate-900 px-2 py-0.5 rounded-lg text-[10px] font-black shadow-sm border border-slate-100">
                  {columnLeads.length}
                </span>
              </div>

              <div className="space-y-3">
                {columnLeads.map((lead: any) => (
                  <div
                    key={lead.id}
                    onClick={() => onLeadClick(lead)}
                    className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-lg hover:-translate-y-0.5 cursor-pointer transition-all active:scale-95"
                  >
                    <div className="flex justify-between items-start mb-3">
                      <span className="text-[8px] bg-indigo-600 text-white px-2 py-0.5 rounded-full font-black uppercase tracking-widest">
                        {lead.industry || 'TRADE'}
                      </span>
                      {(lead.lead_score || 0) >= 70 && <Flame size={12} className="text-orange-500 fill-orange-500 animate-pulse" />}
                    </div>

                    <h4 className="font-black text-slate-800 text-sm uppercase italic leading-none truncate">
                      {lead.name && lead.name !== "" ? lead.name : "NEW LEAD"}
                    </h4>

                    <p className="text-[10px] text-slate-400 font-bold line-clamp-2 mt-2 leading-relaxed italic opacity-70">
                      "{lead.last_message || '...'}"
                    </p>

                    <div className="mt-4 pt-3 border-t border-slate-50 flex items-center justify-between">
                      <div className="flex items-center text-slate-400 gap-1 font-black text-[8px] uppercase tracking-tighter">
                        <MapPin size={10} className="text-indigo-400" /> {lead.location || 'GLOBAL'}
                      </div>
                      <div className="text-[8px] font-black text-indigo-500 italic">SC: {lead.lead_score || 0}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ===== MOBILE: Twitter/X-style feed ===== */}
      <div className="sm:hidden">
        {/* Tab bar — horizontally scrollable, underline-active, sticky under the header */}
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-100 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex px-2">
            {tabs.map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`relative flex-shrink-0 px-4 py-4 text-[11px] font-black uppercase tracking-wider whitespace-nowrap transition-colors ${
                  activeTab === tab ? "text-slate-900" : "text-slate-400"
                }`}
              >
                {tab === "All" ? "All" : tab}
                {activeTab === tab && (
                  <span className="absolute bottom-0 left-4 right-4 h-[3px] bg-indigo-600 rounded-full" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Feed */}
        <div className="divide-y divide-slate-100">
          {feedLeads.length === 0 && (
            <p className="text-center text-slate-300 font-bold text-sm py-16">No leads here yet.</p>
          )}
          {feedLeads.map((lead: any) => (
            <div
              key={lead.id}
              onClick={() => onLeadClick(lead)}
              className="flex gap-3 px-4 py-4 active:bg-slate-50 transition-colors cursor-pointer"
            >
              {/* Avatar */}
              <div className="w-11 h-11 flex-shrink-0 rounded-full bg-slate-900 flex items-center justify-center text-white font-black italic text-base">
                {lead.name ? lead.name[0].toUpperCase() : "P"}
              </div>

              <div className="flex-1 min-w-0">
                {/* Header row: name + industry badge + time */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-black text-slate-900 text-[13px] italic truncate">
                    {lead.name && lead.name !== "" ? lead.name : "New Lead"}
                  </span>
                  <span className="text-[9px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded-full font-black uppercase tracking-wider flex-shrink-0">
                    {lead.industry || 'Trade'}
                  </span>
                  <span className="text-slate-300 text-[11px] flex-shrink-0">·</span>
                  <span className="text-slate-400 text-[11px] font-bold flex-shrink-0">{timeAgo(lead.last_message_at)}</span>
                  {(lead.lead_score || 0) >= 70 && (
                    <Flame size={12} className="text-orange-500 fill-orange-500 flex-shrink-0 ml-auto animate-pulse" />
                  )}
                </div>

                {/* Message body, tweet-style */}
                <p className="text-slate-600 text-[13px] leading-snug mt-0.5 line-clamp-2">
                  {lead.last_message || '...'}
                </p>

                {/* Footer: location + status "engagement row" */}
                <div className="flex items-center gap-4 mt-2 text-slate-400">
                  <div className="flex items-center gap-1 text-[10px] font-bold">
                    <MapPin size={11} className="text-slate-300" /> {lead.location || 'Global'}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-bold">
                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[lead.status] || 'bg-slate-300'}`} />
                    {lead.status}
                  </div>
                  <div className="text-[10px] font-black text-indigo-500 ml-auto">{lead.lead_score || 0}/100</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}