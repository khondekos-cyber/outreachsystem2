"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Kanban, CalendarDays, Moon, LogOut, Zap } from "lucide-react";

const NAV = [
  { name: "Dashboard", icon: LayoutDashboard, href: "/" },
  { name: "Pipeline", icon: Kanban, href: "/pipeline" },
  { name: "Calendar", icon: CalendarDays, href: "/calendar" },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <>
      {/* ===== DESKTOP: left sidebar, unchanged ===== */}
      <div className="hidden sm:flex w-64 h-screen bg-white border-r flex-col fixed left-0 top-0 z-50">
        <div className="p-8 flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white"><Zap size={20} fill="white" /></div>
          <div><h1 className="font-bold text-slate-900 uppercase italic">Outreach</h1><p className="text-[10px] text-slate-400 font-bold uppercase tracking-tighter">AI WhatsApp CRM</p></div>
        </div>
        <nav className="flex-1 px-4 space-y-1">
          {NAV.map((item) => (
            <Link key={item.name} href={item.href} className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${pathname === item.href ? "bg-indigo-50 text-indigo-600" : "text-slate-400 hover:bg-slate-50"}`}>
              <item.icon size={18} />{item.name}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t space-y-1">
          <button className="w-full flex items-center gap-3 px-4 py-3 text-slate-400 font-bold text-sm hover:bg-slate-50 rounded-xl"><Moon size={18}/>Dark Mode</button>
          <button className="w-full flex items-center gap-3 px-4 py-3 text-slate-400 font-bold text-sm hover:bg-slate-50 rounded-xl"><LogOut size={18}/>Sign Out</button>
        </div>
      </div>

      {/* ===== MOBILE: bottom tab bar, Twitter/X app pattern ===== */}
      <div className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-slate-100 flex items-stretch pb-safe">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className="flex-1 flex flex-col items-center justify-center gap-1 py-3"
            >
              <item.icon size={22} className={active ? "text-indigo-600" : "text-slate-400"} strokeWidth={active ? 2.5 : 2} />
              <span className={`text-[9px] font-black uppercase tracking-wider ${active ? "text-indigo-600" : "text-slate-400"}`}>
                {item.name}
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}