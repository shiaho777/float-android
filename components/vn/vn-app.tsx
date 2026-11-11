"use client";

import { useCallback, useState } from "react";
import { VnSelect } from "./vn-select";
import { VnChapters } from "./vn-chapters";
import { VnPlayer } from "./vn-player";
import { loadVnConfig, saveVnConfig } from "@/lib/vn-storage";
import "@/styles/vn.css";

interface VnAppProps {
  onClose: () => void;
}

type VnView = "select" | "chapters" | "player";

export function VnApp({ onClose }: VnAppProps) {
  const [view, setView] = useState<VnView>("select");
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [activeChapterIndex, setActiveChapterIndex] = useState<number>(0);
  const [vnTheme, setVnThemeState] = useState(() => loadVnConfig("theme") || "default");

  const setVnTheme = useCallback((t: string) => {
    setVnThemeState(t);
    saveVnConfig("theme", t);
  }, []);

  const handleCharacterSelect = useCallback((characterId: string) => {
    setSelectedCharacterId(characterId);
    setView("chapters");
  }, []);

  const handleChapterSelect = useCallback((chapterIndex: number) => {
    setActiveChapterIndex(chapterIndex);
    setView("player");
  }, []);

  const handleChapterEnd = useCallback(() => {
    setView("chapters");
  }, []);

  const handleBackFromChapters = useCallback(() => {
    setSelectedCharacterId(null);
    setView("select");
  }, []);

  const handleBackFromPlayer = useCallback(() => {
    setView("chapters");
  }, []);

  const handleOpenAssets = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "resources", resourcePage: "vn_assets" } }));
  }, []);

  if (view === "select") {
    return (
      <VnSelect
        onClose={onClose}
        onSelect={handleCharacterSelect}
        vnTheme={vnTheme}
        onThemeChange={setVnTheme}
        onOpenAssets={handleOpenAssets}
      />
    );
  }

  if (view === "chapters" && selectedCharacterId) {
    return (
      <VnChapters
        characterId={selectedCharacterId}
        onClose={handleBackFromChapters}
        onSelect={handleChapterSelect}
        vnTheme={vnTheme}
      />
    );
  }

  if (view === "player" && selectedCharacterId) {
    return (
      <VnPlayer
        characterId={selectedCharacterId}
        chapterIndex={activeChapterIndex}
        onClose={handleBackFromPlayer}
        onChapterEnd={handleChapterEnd}
        vnTheme={vnTheme}
      />
    );
  }

  return null;
}
