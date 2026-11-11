"use client";

import { useState } from "react";
import { BookOpenText, ChevronLeft } from "lucide-react";

import { DiaryEntriesApp } from "./diary-entries-app";
import "@/styles/diary.css";

type DiaryAppProps = {
  onClose: () => void;
  onNotice?: (message: string) => void;
};

type DiaryView = "home" | "entries";

export function DiaryApp({ onClose, onNotice }: DiaryAppProps) {
  const [view, setView] = useState<DiaryView>("home");
  const todayLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
  }).format(new Date()).toUpperCase();

  if (view === "entries") {
    return <DiaryEntriesApp onBack={() => setView("home")} onNotice={onNotice} />;
  }

  return (
    <section className="diary-app">
      <header className="diary-app-header">
        <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="返回桌面">
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>手记</h1>
          <p>记录角色留下的话</p>
        </div>
        <span className="diary-header-spacer" />
      </header>

      <main className="diary-home">
        <button type="button" className="diary-feature-card diary-feature-card-entry" onClick={() => setView("entries")}>
          <span className="diary-feature-punches diary-feature-punches-left" aria-hidden="true" />
          <span className="diary-feature-punches diary-feature-punches-right" aria-hidden="true" />
          <span className="diary-feature-card-head">
            <span className="diary-feature-label">DIARY</span>
            <span className="diary-feature-number">{todayLabel}</span>
          </span>
          <span className="diary-feature-main">
            <span className="diary-feature-icon">
              <BookOpenText size={20} strokeWidth={1.55} />
            </span>
            <span>
              <strong>日记</strong>
              <em>角色写下的纸页和片段</em>
            </span>
          </span>
          <span className="diary-feature-bottom" aria-hidden="true">
            <span className="diary-feature-barcode" />
            <span className="diary-feature-weather">SUNNY 24C / HUM 62%</span>
          </span>
        </button>

      </main>
    </section>
  );
}
