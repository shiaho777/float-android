"use client";
import { useRef, useEffect } from "react";
import type { StreamMessage } from "@/lib/map-types";
import { BilingualTextBlock } from "@/components/chat/message-bubble";

const emotionColor: Record<string, string> = {
  happy: "#f0c060", sad: "#6888b8", angry: "#c44040", shy: "#c89aaa", worried: "#8090a0",
  neutral: "var(--c-adv-character-name, rgba(255,255,255,0.7))",
};

const emotionEmoji: Record<string, string> = {
  happy: "😊", sad: "😢", angry: "😠", shy: "😳", worried: "😟",
};

export const ADVENTURE_THEMES = [
  { name: "暗夜古卷", preview: "#e8d0a0" },
  { name: "粉彩甜心", preview: "#f8a0c8" },
  { name: "旧纸书卷", preview: "#8b6914" },
  { name: "青苹果园", preview: "#6aaa30" },
  { name: "清水蓝天", preview: "#3a9cc8" },
  { name: "暖阳卡通", preview: "#ff8820" },
];

type Props = {
  messages: StreamMessage[];
  avatarMap?: Record<string, string>;
  fontFamily?: string;
  fontScale?: number;        // multiplier, default 1
  lineHeightScale?: number;  // multiplier, default 1
  bilingualTranslationEnabled?: boolean;
  defaultTranslationExpanded?: boolean;
  loading?: boolean;
  loadingText?: string;
  transparent?: boolean;     // when true, scroll container bg is transparent (for background images)
};

export default function MapTextStream({
  messages,
  avatarMap,
  fontFamily,
  fontScale = 1,
  lineHeightScale = 1,
  bilingualTranslationEnabled = false,
  defaultTranslationExpanded = false,
  loading,
  loadingText,
  transparent,
}: Props) {
  const baseFontSize = 14 * fontScale;
  const baseLineHeight = 1.8 * lineHeightScale;
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (messages.length > prevCount.current || prevCount.current === 0 || loading) {
      requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
      const t = setTimeout(() => { node.scrollTop = node.scrollHeight; }, 500);
      prevCount.current = messages.length;
      return () => clearTimeout(t);
    }
  }, [messages.length, loading]);

  return (
    <div ref={scrollRef} style={{
      flex: 1, overflowY: "auto", padding: "12px 16px",
      display: "flex", flexDirection: "column", gap: 10,
      fontFamily: fontFamily || "var(--c-adv-font)",
      background: transparent ? "transparent" : "var(--c-adv-stream-bg)",
    }}>
      {messages.map(msg => (
        <MessageItem
          key={msg.id}
          msg={msg}
          avatarMap={avatarMap}
          fontSize={baseFontSize}
          lineHeight={baseLineHeight}
          bilingualTranslationEnabled={bilingualTranslationEnabled}
          defaultTranslationExpanded={defaultTranslationExpanded}
        />
      ))}

      {loading && (
        <div style={{ textAlign: "center", padding: "12px 0" }}>
          <style>{`
            @keyframes quill-write {
              0%, 100% { opacity: 0.3; transform: translateY(0); }
              50% { opacity: 1; transform: translateY(-2px); }
            }
          `}</style>
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 6 }}>
            {["🪶", "📜", "✨"].map((c, i) => (
              <span key={i} style={{
                fontSize: "calc(14px*var(--app-text-scale,1))",
                animation: `quill-write 1.2s ease-in-out ${i * 0.3}s infinite`,
              }}>{c}</span>
            ))}
          </div>
          <div style={{
            fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)",
            fontFamily: "inherit", letterSpacing: "0.15em",
          }}>
            {loadingText || "DM 正在书写命运..."}
          </div>
        </div>
      )}
    </div>
  );
}

function SpeakerAvatar({ src, fallback, size = 20 }: { src?: string; fallback?: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      backgroundImage: src ? `url(${src})` : "none",
      backgroundColor: src ? "transparent" : "var(--c-adv-choice-bg)",
      backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat",
      border: "1px solid var(--c-adv-input-border)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.5, color: "var(--c-adv-text-muted)",
    }}>
      {!src && (fallback || "?")}
    </div>
  );
}

function MessageItem({
  msg,
  avatarMap,
  fontSize,
  lineHeight,
  bilingualTranslationEnabled,
  defaultTranslationExpanded,
}: {
  msg: StreamMessage;
  avatarMap?: Record<string, string>;
  fontSize: number;
  lineHeight: number;
  bilingualTranslationEnabled: boolean;
  defaultTranslationExpanded: boolean;
}) {
  const avatar = msg.speaker ? avatarMap?.[msg.speaker] : undefined;

  switch (msg.type) {
    case "narration":
      return (
        <div style={{
          textAlign: "center", padding: "4px 12px",
          fontSize: fontSize * 0.93, fontStyle: "italic", lineHeight,
          color: "var(--c-adv-narration)", whiteSpace: "pre-wrap",
        }}>
          {msg.text}
        </div>
      );

    case "npc":
      return (
        <div style={{
          padding: "var(--c-adv-msg-padding)", borderLeft: `2px var(--c-adv-msg-border-style) var(--c-adv-npc-border)`,
          borderRadius: "var(--c-adv-msg-radius)",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6, marginBottom: 3,
          }}>
            <SpeakerAvatar src={avatar} fallback={msg.speaker?.[0]} size={18} />
            <span style={{
              fontSize: "calc(11px*var(--app-text-scale,1))", fontWeight: 600, letterSpacing: "0.05em",
              color: "var(--c-adv-npc-name)",
            }}>
              {msg.speaker}
            </span>
          </div>
          <div style={{ fontSize, lineHeight, color: "var(--c-adv-body)", whiteSpace: "pre-wrap" }}>
            {msg.text}
          </div>
        </div>
      );

    case "player":
      return (
        <div style={{
          padding: "var(--c-adv-msg-padding)", borderLeft: `2px var(--c-adv-msg-border-style) var(--c-adv-player-border)`,
          borderRadius: "var(--c-adv-msg-radius)",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6, marginBottom: 3,
          }}>
            <SpeakerAvatar src={avatar} fallback="你" size={18} />
            <span style={{
              fontSize: "calc(11px*var(--app-text-scale,1))", fontWeight: 600, letterSpacing: "0.05em",
              color: "var(--c-adv-player-name)",
            }}>
              {msg.speaker || "你"}
            </span>
          </div>
          <div style={{ fontSize, lineHeight, color: "var(--c-adv-body)", whiteSpace: "pre-wrap" }}>
            {msg.text}
          </div>
        </div>
      );

    case "character": {
      const color = emotionColor[msg.emotion || "neutral"] || emotionColor.neutral;
      const borderColor = color.startsWith("rgba(")
        ? color.replace(/[\d.]+\)$/, "0.35)")
        : `${color}60`;
      return (
        <div style={{
          padding: "var(--c-adv-msg-padding)",
          borderLeft: `2px var(--c-adv-msg-border-style) ${borderColor}`,
          borderRadius: "var(--c-adv-msg-radius)",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6, marginBottom: 3,
          }}>
            <SpeakerAvatar src={avatar} fallback={msg.speaker?.[0]} size={18} />
            <span style={{
              fontSize: "calc(11px*var(--app-text-scale,1))", fontWeight: 600, letterSpacing: "0.05em",
              color,
            }}>
              {msg.speaker}
            </span>
            {msg.emotion && emotionEmoji[msg.emotion] && (
              <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))" }}>{emotionEmoji[msg.emotion]}</span>
            )}
          </div>
          <div style={{ fontSize, lineHeight, color: "var(--c-adv-body)", whiteSpace: "pre-wrap" }}>
            {bilingualTranslationEnabled ? (
              <BilingualTextBlock
                text={msg.text}
                mode="plain"
                defaultExpanded={defaultTranslationExpanded}
              />
            ) : (
              msg.text
            )}
          </div>
        </div>
      );
    }

    case "system":
      return (
        <div style={{
          textAlign: "center", padding: "2px 0",
          fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-system)",
          fontFamily: "monospace", letterSpacing: "0.1em",
          overflowWrap: "break-word", wordBreak: "break-all",
        }}>
          {msg.text}
        </div>
      );

    case "location":
      return (
        <div style={{
          textAlign: "center", padding: "10px 0",
          borderTop: "1px solid var(--c-adv-input-border)",
          borderBottom: "1px solid var(--c-adv-input-border)",
          margin: "4px 0",
        }}>
          <span style={{
            fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-location)", letterSpacing: "0.1em",
          }}>
            {msg.text}
          </span>
        </div>
      );

    case "roll":
      return (
        <div style={{ textAlign: "center", padding: "8px 0" }}>
          <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4 }}>
            {msg.speaker}
          </div>
          <div style={{
            fontSize: "calc(22px*var(--app-text-scale,1))", fontWeight: 700, letterSpacing: "0.15em",
            color: msg.emotion === "success" ? "#f0c060" : "#c44040",
          }}>
            {msg.text}
          </div>
        </div>
      );

    default:
      return null;
  }
}
