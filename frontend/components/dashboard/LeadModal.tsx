"use client";
import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@supabase/supabase-js";
import { X, MapPin, Target, Bot, BotOff, Flame, Send } from "lucide-react";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function LeadModal({ lead, onClose }: any) {
  const [messages, setMessages] = useState<any[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [aiActive, setAiActive] = useState<boolean>(lead.ai_active !== false);
  const [togglingAi, setTogglingAi] = useState(false);
  const [mobileTab, setMobileTab] = useState<"chat" | "details">("chat");
  const scrollRef = useRef<HTMLDivElement>(null);

  const toggleAi = async () => {
    if (togglingAi) return;
    const next = !aiActive;
    setTogglingAi(true);
    setAiActive(next); // optimistic

    // .select() after update lets us confirm a row actually changed.
    // Under RLS, a blocked update often returns no error at all — just 0 rows —
    // so checking `error` alone isn't enough to know it really worked.
    const { data, error } = await supabase
      .from("leads")
      .update({ ai_active: next })
      .eq("id", lead.id)
      .select();

    if (error || !data || data.length === 0) {
      console.error("Failed to toggle AI status:", error?.message || "0 rows updated — check RLS policies on leads.");
      setAiActive(!next); // revert
    }
    setTogglingAi(false);
  };

  // Needed so createPortal only runs client-side (document isn't available during SSR)
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!lead?.id) return;
    fetchMessages();

    const sub = supabase
      .channel(`live-chat-${lead.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `lead_id=eq.${lead.id}` },
        (p) => {
          setMessages((prev) => (prev.some((m) => m.id === p.new.id) ? prev : [...prev, p.new]));
        }
      )
      .subscribe();

    // Realtime can silently miss events (publication not enabled, dropped connection, etc.)
    // so we also poll as a safety net every 4s while the modal is open.
    const poll = setInterval(fetchMessages, 4000);

    return () => {
      supabase.removeChannel(sub);
      clearInterval(poll);
    };
  }, [lead.id]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const fetchMessages = async () => {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("Failed to load messages:", error.message);
      return;
    }
    if (data) setMessages(data);
  };

  const sendManualReply = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft("");

    // Optimistic insert so it feels instant; if it fails, remove it.
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [...prev, { id: tempId, body, from_me: true, created_at: new Date().toISOString() }]);

    const { data, error } = await supabase
      .from("messages")
      .insert({ lead_id: lead.id, body, from_me: true })
      .select();

    if (error || !data || data.length === 0) {
      console.error("Failed to send manual reply:", error?.message || "0 rows inserted — check RLS policies on messages.");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    } else {
      fetchMessages();
    }
    setSending(false);
  };

  if (!mounted) return null;

  const modal = (
    <div className="fixed inset-0 bg-slate-900/70 sm:backdrop-blur-md flex items-center justify-center z-[100] sm:p-6 text-slate-800">
      <div className="bg-white w-full h-full sm:h-[85vh] sm:max-w-6xl rounded-none sm:rounded-[48px] flex flex-col sm:flex-row overflow-hidden shadow-2xl sm:border-4 sm:border-white">

        {/* MOBILE-ONLY: shared top bar + Chat/Details tab switch.
            On desktop the two panels sit side by side so this is unnecessary. */}
        <div className="sm:hidden flex flex-col border-b border-slate-100 flex-shrink-0">
          <div className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 flex-shrink-0 bg-slate-900 rounded-2xl flex items-center justify-center text-white font-black text-lg italic shadow-lg rotate-3">
                {lead.name ? lead.name[0] : "P"}
              </div>
              <div className="min-w-0">
                <h3 className="font-black text-base text-slate-900 leading-none truncate">{lead.name || "Prospect"}</h3>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${aiActive ? "bg-green-500 animate-pulse" : "bg-slate-300"}`} />
                  <span className={`text-[9px] font-black uppercase tracking-widest ${aiActive ? "text-green-500" : "text-slate-400"}`}>
                    {aiActive ? "Sales Mode Active" : "AI Paused"}
                  </span>
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-2.5 bg-slate-50 rounded-full flex-shrink-0 ml-2">
              <X size={20} />
            </button>
          </div>
          <div className="flex px-4 pb-3 gap-2">
            <button
              onClick={() => setMobileTab("chat")}
              className={`flex-1 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-colors ${
                mobileTab === "chat" ? "bg-indigo-600 text-white" : "bg-slate-50 text-slate-400"
              }`}
            >
              Chat
            </button>
            <button
              onClick={() => setMobileTab("details")}
              className={`flex-1 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-colors ${
                mobileTab === "details" ? "bg-indigo-600 text-white" : "bg-slate-50 text-slate-400"
              }`}
            >
              Details
            </button>
          </div>
        </div>

        {/* INTELLIGENCE PANEL — full width tab on mobile, 35% side panel on desktop */}
        <div className={`${mobileTab === "details" ? "flex" : "hidden"} sm:flex flex-col w-full sm:w-[35%] bg-slate-50 sm:border-r p-6 sm:p-10 overflow-y-auto`}>
          <h2 className="hidden sm:block text-2xl font-black uppercase italic tracking-tighter mb-10 text-slate-900 leading-none">Lead Intelligence</h2>
          <div className="space-y-6 sm:space-y-8">
            <div className="flex flex-wrap gap-2">
              <span className="bg-indigo-600 text-white text-[10px] px-5 py-2 rounded-full font-black uppercase tracking-widest leading-none shadow-lg shadow-indigo-200">
                {lead.industry || "PROSPECT"}
              </span>
              {lead.stat_info && (
                <span className="bg-orange-100 text-orange-600 text-[10px] px-5 py-2 rounded-full font-black uppercase tracking-widest border border-orange-200 flex items-center gap-2">
                  <Flame size={12} fill="currentColor" /> {lead.stat_info}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-6 pt-6 sm:pt-8 border-t">
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Region</label>
                <div className="flex items-center gap-2 font-black text-slate-700 italic uppercase">
                  <MapPin size={14} className="text-indigo-500" />
                  {lead.location || "Unknown"}
                </div>
              </div>
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-2">Lead Score</label>
                <div className="flex items-center gap-2 font-black text-indigo-600 text-2xl italic leading-none">
                  <Target size={20} className="text-indigo-400" />
                  {lead.lead_score || 0}/100
                </div>
              </div>
            </div>

            <div className="pt-6 sm:pt-8 border-t border-slate-200">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 block">Sales Process / Script</label>
              <div className="bg-white p-6 rounded-[32px] border border-slate-100 shadow-sm text-sm text-slate-600 leading-relaxed font-bold italic border-l-8 border-l-indigo-600">
                "{lead.sales_process || "Not gathered yet"}"
              </div>
            </div>

            <button
              onClick={toggleAi}
              disabled={togglingAi}
              className={`w-full font-black py-5 rounded-[32px] mt-6 sm:mt-10 shadow-xl transition-all uppercase text-xs tracking-[0.3em] flex items-center justify-center gap-3 disabled:opacity-60 ${
                aiActive
                  ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-100"
                  : "bg-slate-200 hover:bg-slate-300 text-slate-600 shadow-slate-100"
              }`}
            >
              {aiActive ? <Bot size={18} /> : <BotOff size={18} />}
              {aiActive ? "AI Auto-Reply: ON" : "AI Auto-Reply: OFF"}
            </button>
            {!aiActive && (
              <p className="text-[10px] text-slate-400 font-bold text-center -mt-4 leading-relaxed">
                The AI won't reply to this lead. You're handling it manually below.
              </p>
            )}
          </div>
        </div>

        {/* CHAT PANEL — full width tab on mobile, 65% side panel on desktop */}
        <div className={`${mobileTab === "chat" ? "flex" : "hidden"} sm:flex flex-col w-full sm:w-[65%] bg-white min-h-0`}>
          {/* Desktop-only header — the mobile shared top bar above covers this on small screens */}
          <div className="hidden sm:flex p-8 border-b justify-between items-center">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-slate-900 rounded-2xl flex items-center justify-center text-white font-black text-xl italic shadow-lg rotate-3">
                {lead.name ? lead.name[0] : "P"}
              </div>
              <div>
                <h3 className="font-black text-xl text-slate-900 leading-none">{lead.name || "Prospect"}</h3>
                <div className="flex items-center gap-1.5 mt-2">
                  <span className={`w-2 h-2 rounded-full ${aiActive ? "bg-green-500 animate-pulse" : "bg-slate-300"}`} />
                  <span className={`text-[10px] font-black uppercase tracking-widest ${aiActive ? "text-green-500" : "text-slate-400"}`}>
                    {aiActive ? "Sales Mode Active" : "AI Paused — Manual Mode"}
                  </span>
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-3 bg-slate-50 rounded-full hover:bg-slate-100 transition-all">
              <X size={24} />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 bg-[#fcfdfe] p-4 sm:p-10 overflow-y-auto space-y-4 sm:space-y-6 scroll-smooth min-h-0">
            {messages.length === 0 && (
              <p className="text-center text-slate-300 font-bold text-sm mt-10">No messages yet.</p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex flex-col ${m.from_me ? "items-end" : "items-start"}`}>
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-300 mb-1 px-2">
                  {m.from_me ? "You / AI" : lead.name || "Lead"}
                </span>
                <div
                  className={`max-w-[85%] sm:max-w-[75%] p-4 sm:p-6 rounded-[28px] sm:rounded-[32px] text-sm sm:text-[15px] leading-relaxed font-bold shadow-sm ${
                    m.from_me
                      ? "bg-indigo-600 text-white rounded-tr-none"
                      : "bg-white border border-slate-100 rounded-tl-none text-slate-800"
                  }`}
                >
                  {m.body}
                </div>
              </div>
            ))}
          </div>

          <div className="p-4 sm:p-8 bg-white border-t border-slate-50 flex gap-3 sm:gap-4 flex-shrink-0">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendManualReply()}
              disabled={sending}
              className="flex-1 min-w-0 bg-slate-50 p-4 sm:p-6 rounded-[24px] sm:rounded-[28px] outline-none text-sm font-black border-2 border-transparent focus:border-indigo-100 focus:bg-white transition-all shadow-inner disabled:opacity-50"
              placeholder="Type manual reply..."
            />
            <button
              onClick={sendManualReply}
              disabled={sending || !draft.trim()}
              className="bg-slate-900 text-white px-5 sm:px-10 rounded-[24px] sm:rounded-[28px] font-black uppercase text-xs tracking-widest disabled:opacity-40 flex items-center gap-2 flex-shrink-0"
            >
              <Send size={14} /> <span className="hidden sm:inline">Send</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
