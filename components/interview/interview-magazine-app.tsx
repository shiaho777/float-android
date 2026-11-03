"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic2,
  Menu,
  Pause,
  PencilLine,
  Plus,
  Radio,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import {
  composeInterviewArticle,
  formatInterviewTranscript,
  generateCharacterInterviewAnswer,
  generateHostOpening,
  generateHostQuestion,
  makeInterviewMessage,
} from "@/lib/interview-magazine-engine";
import {
  deleteInterviewDraft,
  deleteInterviewIssue,
  getNextInterviewIssueNumber,
  loadInterviewDrafts,
  loadInterviewHostPrompt,
  loadInterviewIssues,
  loadInterviewMemoryPrompt,
  saveInterviewDraft,
  saveInterviewHostPrompt,
  saveInterviewIssue,
  saveInterviewMemoryPrompt,
} from "@/lib/interview-magazine-storage";
import {
  deleteInterviewMagazineProjectionEventForIssue,
  recordInterviewMagazineProjectionEvent,
} from "@/lib/interview-magazine-memory";
import {
  INTERVIEW_MAGAZINE_DEFAULT_HOST_PROMPT,
  INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT,
  INTERVIEW_MAGAZINE_HOST_NAME,
  INTERVIEW_MAGAZINE_TITLE,
  INTERVIEW_MAGAZINE_TITLE_CN,
  type InterviewDraft,
  type InterviewDraftStatus,
  type InterviewIssue,
  type InterviewMessage,
} from "@/lib/interview-magazine-types";
import { incrementEventCounter } from "@/lib/memory-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { loadUserIdentities, resolveUserIdentity } from "@/lib/settings-storage";

type Props = {
  onClose: () => void;
};

type Screen = "home" | "setup" | "interview" | "generating" | "article";
type InterviewPhase = "opening" | "host" | "character" | "user" | "paused" | "done" | "error";
type InterviewResumeAction =
  | { type: "opening"; theme: string }
  | { type: "awaitUser" }
  | { type: "finish"; baseMessages: InterviewMessage[] }
  | {
      type: "character";
      question: string;
      baseMessages: InterviewMessage[];
      round: number;
      answeringCharacterId: string;
      lastUserAnswer?: string;
      currentTheme: string;
    }
  | { type: "hostToUser"; baseMessages: InterviewMessage[]; currentTheme: string }
  | {
      type: "hostToCharacter";
      baseMessages: InterviewMessage[];
      lastUserAnswer: string;
      fallbackTargetCharacterId: string;
      nextRound: number;
      currentTheme: string;
    };

const THEME_CHIPS = ["关系的暗面", "一次漫长的告别", "未完成的愿望", "被误解的瞬间", "选择的代价", "夜里真实的自己"];
const CHINESE_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function formatChineseOrdinalNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  if (value < 10) return CHINESE_DIGITS[value];
  if (value < 20) return `十${value % 10 === 0 ? "" : CHINESE_DIGITS[value % 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${CHINESE_DIGITS[tens]}十${ones === 0 ? "" : CHINESE_DIGITS[ones]}`;
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    return `${CHINESE_DIGITS[hundreds]}百${rest === 0 ? "" : formatChineseOrdinalNumber(rest)}`;
  }
  return String(value);
}

function resolveSuggestedIdentityId(characterIds: string[], identities: UserIdentity[]): string {
  if (identities.length === 0) return "";
  const resolved = characterIds
    .map((id) => resolveUserIdentity(id, "interview_magazine"))
    .filter(Boolean) as UserIdentity[];
  const uniqueIds = new Set(resolved.map((identity) => identity.id));
  if (resolved.length > 0 && uniqueIds.size === 1) return resolved[0].id;
  return identities[0]?.id ?? "";
}

function hasMixedIdentityBindings(characterIds: string[]): boolean {
  const resolved = characterIds
    .map((id) => resolveUserIdentity(id, "interview_magazine")?.id)
    .filter(Boolean);
  return new Set(resolved).size > 1;
}

function getMaxCharacterTurns(count: number): number {
  return Math.min(6, Math.max(3, count * 2));
}

function getIssueGuestNames(issue: InterviewIssue): string[] {
  if (issue.characterNames && issue.characterNames.length > 0) return issue.characterNames;
  if (issue.guestSnapshots && issue.guestSnapshots.length > 0) {
    return issue.guestSnapshots.map((guest) => guest.characterName);
  }
  return [issue.characterName].filter(Boolean);
}

function getIssueParticipantText(issue: InterviewIssue): string {
  return `${getIssueGuestNames(issue).join("、")} · ${issue.userName || "共同受访者"}`;
}

function getDraftParticipantText(draft: InterviewDraft): string {
  const names = draft.characterNames.length > 0 ? draft.characterNames : draft.characterIds;
  return `${names.join("、") || "嘉宾"}${draft.userName ? ` · ${draft.userName}` : ""}`;
}

function getDraftStatusText(status: InterviewDraftStatus): string {
  if (status === "error") return "录制中断";
  if (status === "awaiting_user") return "等待回应";
  if (status === "done") return "待成刊";
  return "已暂停";
}

function getIssueCharacterNameMap(issue: InterviewIssue): Record<string, string> {
  if (issue.guestSnapshots && issue.guestSnapshots.length > 0) {
    return Object.fromEntries(issue.guestSnapshots.map((guest) => [guest.characterId, guest.characterName]));
  }
  return issue.characterId ? { [issue.characterId]: issue.characterName } : {};
}

function SmallCaps({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`interview-small-caps ${className}`}>{children}</span>;
}

function BackgroundLayer({ imageUrl }: { imageUrl?: string | null }) {
  return (
    <div className="interview-glass-bg">
      {imageUrl ? (
        <img src={imageUrl} alt="" />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-stone-900 to-black" />
      )}
      <div className="overlay" />
    </div>
  );
}

export function InterviewMagazineApp({ onClose }: Props) {
  const [screen, setScreen] = useState<Screen>("home");
  const [issues, setIssues] = useState<InterviewIssue[]>([]);
  const [drafts, setDrafts] = useState<InterviewDraft[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [userIdentities, setUserIdentities] = useState<UserIdentity[]>([]);
  const [activeIssue, setActiveIssue] = useState<InterviewIssue | null>(null);
  const [theme, setTheme] = useState("");
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<string[]>([]);
  const [userIdentityId, setUserIdentityId] = useState("");
  const [messages, setMessages] = useState<InterviewMessage[]>([]);
  const [phase, setPhase] = useState<InterviewPhase>("opening");
  const [pendingLabel, setPendingLabel] = useState("");
  const [userInput, setUserInput] = useState("");
  const [error, setError] = useState("");
  const [resumeAction, setResumeAction] = useState<InterviewResumeAction | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [characterRounds, setCharacterRounds] = useState(0);
  const [hostPrompt, setHostPrompt] = useState(INTERVIEW_MAGAZINE_DEFAULT_HOST_PROMPT);
  const [memoryPrompt, setMemoryPrompt] = useState(INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composeRunRef = useRef(0);
  const resumeActionRef = useRef<InterviewResumeAction | null>(null);
  const interviewRunRef = useRef(0);

  useEffect(() => {
    setIssues(loadInterviewIssues());
    setDrafts(loadInterviewDrafts());
    setHostPrompt(loadInterviewHostPrompt());
    setMemoryPrompt(loadInterviewMemoryPrompt());
    const loadedCharacters = loadCharacters();
    const loadedIdentities = loadUserIdentities();
    setCharacters(loadedCharacters);
    setUserIdentities(loadedIdentities);
    const firstCharacterId = loadedCharacters[0]?.id ?? "";
    setSelectedCharacterIds(firstCharacterId ? [firstCharacterId] : []);
    setUserIdentityId(resolveSuggestedIdentityId(firstCharacterId ? [firstCharacterId] : [], loadedIdentities));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, phase]);

  useEffect(() => {
    if (userIdentities.length === 0) return;
    if (userIdentityId && userIdentities.some((identity) => identity.id === userIdentityId)) return;
    setUserIdentityId(resolveSuggestedIdentityId(selectedCharacterIds, userIdentities));
  }, [selectedCharacterIds, userIdentities, userIdentityId]);

  const activeCharacters = useMemo(
    () => selectedCharacterIds
      .map((id) => characters.find((character) => character.id === id))
      .filter(Boolean) as Character[],
    [characters, selectedCharacterIds],
  );

  const activeCharacter = activeCharacters[0] ?? null;
  const maxCharacterTurns = getMaxCharacterTurns(selectedCharacterIds.length);

  const bgImageUrl = activeIssue?.guestSnapshots?.[0]?.characterSnapshot?.avatar
    || activeIssue?.characterSnapshot?.avatar
    || activeCharacter?.avatar
    || characters[0]?.avatar;

  const resetDraft = () => {
    setTheme("");
    setMessages([]);
    setPhase("opening");
    setPendingLabel("");
    setUserInput("");
    setError("");
    setResumeAction(null);
    setActiveDraftId(null);
    resumeActionRef.current = null;
    setCharacterRounds(0);
  };

  const armResumeAction = (action: InterviewResumeAction) => {
    resumeActionRef.current = action;
    setResumeAction(action);
    setError("");
  };

  const clearResumeAction = () => {
    resumeActionRef.current = null;
    setResumeAction(null);
  };

  const pauseInterview = () => {
    if (!resumeActionRef.current) return;
    stopInterviewRun();
    setError("");
    setPendingLabel("");
    setPhase("paused");
    persistCurrentDraft("paused");
  };

  const startInterviewRun = () => {
    const runId = interviewRunRef.current + 1;
    interviewRunRef.current = runId;
    return runId;
  };

  const stopInterviewRun = () => {
    interviewRunRef.current += 1;
  };

  const isInterviewRunCurrent = (runId: number) => interviewRunRef.current === runId;

  const resolveDraftStatus = (): InterviewDraftStatus => {
    if (phase === "error") return "error";
    if (phase === "user") return "awaiting_user";
    if (phase === "done") return "done";
    return "paused";
  };

  const createCurrentDraft = (status = resolveDraftStatus()): InterviewDraft | null => {
    const trimmedTheme = theme.trim();
    if (!trimmedTheme || selectedCharacterIds.length === 0) return null;
    const previousDraft = activeDraftId ? drafts.find((draft) => draft.id === activeDraftId) : null;
    const now = new Date().toISOString();
    const action = status === "awaiting_user"
      ? { type: "awaitUser" as const }
      : status === "done"
        ? undefined
        : resumeActionRef.current ?? undefined;
    return {
      id: activeDraftId || `interview_draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      theme: trimmedTheme,
      characterIds: selectedCharacterIds,
      characterNames: activeCharacters.map((character) => character.name),
      userIdentityId,
      userName: userIdentities.find((identity) => identity.id === userIdentityId)?.name,
      transcript: messages,
      characterRounds,
      status,
      resumeAction: action,
      userInput,
      error,
      createdAt: previousDraft?.createdAt || now,
      updatedAt: now,
    };
  };

  const persistCurrentDraft = (status = resolveDraftStatus()) => {
    const draft = createCurrentDraft(status);
    if (!draft) return null;
    setDrafts(saveInterviewDraft(draft));
    setActiveDraftId(draft.id);
    return draft;
  };

  const inferDraftResumeAction = (draft: InterviewDraft): InterviewResumeAction | null => {
    const action = draft.resumeAction as InterviewResumeAction | null | undefined;
    if (action) return action;
    if (draft.status === "awaiting_user") return { type: "awaitUser" };
    if (draft.status === "done") return null;
    if (draft.transcript.length === 0) return { type: "opening", theme: draft.theme };
    return { type: "awaitUser" };
  };

  const openDraft = (draft: InterviewDraft) => {
    stopInterviewRun();
    startInterviewRun();
    const action = inferDraftResumeAction(draft);
    setActiveDraftId(draft.id);
    setTheme(draft.theme);
    setSelectedCharacterIds(draft.characterIds);
    setUserIdentityId(draft.userIdentityId || resolveSuggestedIdentityId(draft.characterIds, userIdentities));
    setMessages(draft.transcript);
    setCharacterRounds(draft.characterRounds);
    setUserInput(draft.userInput || "");
    setError(draft.error || "");
    resumeActionRef.current = action;
    setResumeAction(action);
    setPendingLabel("");
    setPhase(
      draft.status === "awaiting_user"
        ? "user"
        : draft.status === "done"
          ? "done"
          : draft.status === "error"
            ? "error"
            : "paused",
    );
    setScreen("interview");
  };

  const exitInterviewToHome = () => {
    persistCurrentDraft(resolveDraftStatus());
    stopInterviewRun();
    resetDraft();
    setScreen("home");
  };

  const toggleCharacter = (id: string) => {
    setSelectedCharacterIds((previous) => {
      const next = previous.includes(id)
        ? previous.filter((characterId) => characterId !== id)
        : [...previous, id];
      if (next.length > 0 && !userIdentityId) {
        setUserIdentityId(resolveSuggestedIdentityId(next, userIdentities));
      }
      return next;
    });
  };

  const getNextCharacterId = (currentCharacterId?: string): string => {
    if (selectedCharacterIds.length === 0) return "";
    const currentIndex = currentCharacterId ? selectedCharacterIds.indexOf(currentCharacterId) : -1;
    return selectedCharacterIds[(currentIndex + 1 + selectedCharacterIds.length) % selectedCharacterIds.length];
  };

  const startInterview = async () => {
    const trimmedTheme = theme.trim();
    if (!trimmedTheme || selectedCharacterIds.length === 0) return;
    resetDraft();
    const runId = startInterviewRun();
    setTheme(trimmedTheme);
    setScreen("interview");
    setPhase("opening");
    setPendingLabel(`主持人 ${INTERVIEW_MAGAZINE_HOST_NAME}`);
    armResumeAction({ type: "opening", theme: trimmedTheme });

    try {
      const opening = await generateHostOpening(trimmedTheme, selectedCharacterIds, userIdentityId);
      if (!isInterviewRunCurrent(runId)) return;
      const initialMessages = [
        makeInterviewMessage("host", opening.intro, { kind: "intro" }),
        makeInterviewMessage("host", opening.question, {
          kind: "question",
          target: "character",
          targetCharacterId: opening.targetCharacterId,
          targetCharacterName: opening.targetCharacterName,
        }),
      ];
      setMessages(initialMessages);
      await runCharacterAnswer(opening.question, initialMessages, 1, opening.targetCharacterId, undefined, trimmedTheme, runId);
    } catch (err) {
      if (!isInterviewRunCurrent(runId)) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    } finally {
      if (isInterviewRunCurrent(runId)) setPendingLabel("");
    }
  };

  const runCharacterAnswer = async (
    question: string,
    baseMessages: InterviewMessage[],
    round: number,
    answeringCharacterId: string,
    lastUserAnswer?: string,
    currentTheme?: string,
    runId = interviewRunRef.current,
  ) => {
    const activeTheme = currentTheme ?? theme;
    const answeringCharacter = characters.find((character) => character.id === answeringCharacterId) ?? activeCharacter;
    setPhase("character");
    setPendingLabel(answeringCharacter?.name || "嘉宾");
    armResumeAction({
      type: "character",
      question,
      baseMessages,
      round,
      answeringCharacterId,
      lastUserAnswer,
      currentTheme: activeTheme,
    });
    const answer = await generateCharacterInterviewAnswer({
      theme: activeTheme,
      characterIds: selectedCharacterIds,
      characterId: answeringCharacterId,
      userIdentityId,
      question,
      transcript: baseMessages,
      round,
      lastUserAnswer,
    });
    if (!isInterviewRunCurrent(runId)) return;
    const withAnswer = [...baseMessages, makeInterviewMessage("character", answer, {
      kind: "answer",
      speakerCharacterId: answeringCharacterId,
      speakerName: answeringCharacter?.name || "嘉宾",
    })];
    setMessages(withAnswer);
    setCharacterRounds(round);

    if (round >= maxCharacterTurns) {
      const thanksLabel = selectedCharacterIds.length > 1 ? "各位" : "两位";
      setMessages([...withAnswer, makeInterviewMessage("host", `感谢${thanksLabel}。本期访谈到这里告一段落。`, { kind: "outro" })]);
      setPhase("done");
      setPendingLabel("");
      clearResumeAction();
      return;
    }

    setPhase("host");
    setPendingLabel(`主持人 ${INTERVIEW_MAGAZINE_HOST_NAME}`);
    armResumeAction({ type: "hostToUser", baseMessages: withAnswer, currentTheme: activeTheme });
    const nextQuestion = await generateHostQuestion({
      theme: activeTheme,
      characterIds: selectedCharacterIds,
      userIdentityId,
      transcript: withAnswer,
      target: "user",
      phase: "嘉宾刚刚回答完，主持人需要把问题转向共同受访者",
    });
    if (!isInterviewRunCurrent(runId)) return;
    setMessages([...withAnswer, makeInterviewMessage("host", nextQuestion.question, { kind: "question", target: "user" })]);
    setPhase("user");
    setPendingLabel("");
    clearResumeAction();
  };

  const submitUserAnswer = async () => {
    const answer = userInput.trim();
    if (!answer || phase !== "user") return;
    setUserInput("");
    const runId = interviewRunRef.current;
    const withUserAnswer = [...messages, makeInterviewMessage("user", answer, { kind: "answer" })];
    setMessages(withUserAnswer);
    setPhase("host");
    setPendingLabel(`主持人 ${INTERVIEW_MAGAZINE_HOST_NAME}`);
    const latestSpeakerId = [...withUserAnswer].reverse().find((message) => message.role === "character")?.speakerCharacterId;
    const fallbackTargetCharacterId = getNextCharacterId(latestSpeakerId);
    armResumeAction({
      type: "hostToCharacter",
      baseMessages: withUserAnswer,
      lastUserAnswer: answer,
      fallbackTargetCharacterId,
      nextRound: characterRounds + 1,
      currentTheme: theme,
    });

    try {
      const nextQuestion = await generateHostQuestion({
        theme,
        characterIds: selectedCharacterIds,
        userIdentityId,
        transcript: withUserAnswer,
        target: "character",
        phase: "用户刚刚回答完，主持人需要把问题抛回嘉宾",
        fallbackTargetCharacterId,
      });
      if (!isInterviewRunCurrent(runId)) return;
      const targetCharacterId = nextQuestion.targetCharacterId || fallbackTargetCharacterId;
      const targetCharacterName = nextQuestion.targetCharacterName
        || characters.find((character) => character.id === targetCharacterId)?.name
        || "嘉宾";
      const withQuestion = [...withUserAnswer, makeInterviewMessage("host", nextQuestion.question, {
        kind: "question",
        target: "character",
        targetCharacterId,
        targetCharacterName,
      })];
      setMessages(withQuestion);
      await runCharacterAnswer(nextQuestion.question, withQuestion, characterRounds + 1, targetCharacterId, answer, theme, runId);
    } catch (err) {
      if (!isInterviewRunCurrent(runId)) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
      setPendingLabel("");
    }
  };

  const continueInterview = async () => {
    const action = resumeActionRef.current;
    if (!action) return;

    const runId = startInterviewRun();
    setError("");
    setScreen("interview");

    try {
      if (action.type === "finish") {
        const thanksLabel = selectedCharacterIds.length > 1 ? "各位" : "两位";
        setMessages([...action.baseMessages, makeInterviewMessage("host", `感谢${thanksLabel}。本期访谈到这里告一段落。`, { kind: "outro" })]);
        setPhase("done");
        setPendingLabel("");
        clearResumeAction();
        return;
      }

      if (action.type === "awaitUser") {
        setPhase("user");
        setPendingLabel("");
        clearResumeAction();
        return;
      }

      if (action.type === "opening") {
        setTheme(action.theme);
        setPhase("opening");
        setPendingLabel(`主持人 ${INTERVIEW_MAGAZINE_HOST_NAME}`);
        armResumeAction(action);
        const opening = await generateHostOpening(action.theme, selectedCharacterIds, userIdentityId);
        const initialMessages = [
          makeInterviewMessage("host", opening.intro, { kind: "intro" }),
          makeInterviewMessage("host", opening.question, {
            kind: "question",
            target: "character",
            targetCharacterId: opening.targetCharacterId,
            targetCharacterName: opening.targetCharacterName,
          }),
        ];
        if (!isInterviewRunCurrent(runId)) return;
        setMessages(initialMessages);
        await runCharacterAnswer(opening.question, initialMessages, 1, opening.targetCharacterId, undefined, action.theme, runId);
        return;
      }

      if (action.type === "character") {
        await runCharacterAnswer(
          action.question,
          action.baseMessages,
          action.round,
          action.answeringCharacterId,
          action.lastUserAnswer,
          action.currentTheme,
          runId,
        );
        return;
      }

      if (action.type === "hostToUser") {
        setPhase("host");
        setPendingLabel(`主持人 ${INTERVIEW_MAGAZINE_HOST_NAME}`);
        armResumeAction(action);
        const nextQuestion = await generateHostQuestion({
          theme: action.currentTheme,
          characterIds: selectedCharacterIds,
          userIdentityId,
          transcript: action.baseMessages,
          target: "user",
          phase: "嘉宾刚刚回答完，主持人需要把问题转向共同受访者",
        });
        if (!isInterviewRunCurrent(runId)) return;
        setMessages([...action.baseMessages, makeInterviewMessage("host", nextQuestion.question, { kind: "question", target: "user" })]);
        setPhase("user");
        setPendingLabel("");
        clearResumeAction();
        return;
      }

      setPhase("host");
      setPendingLabel(`主持人 ${INTERVIEW_MAGAZINE_HOST_NAME}`);
      armResumeAction(action);
      const nextQuestion = await generateHostQuestion({
        theme: action.currentTheme,
        characterIds: selectedCharacterIds,
        userIdentityId,
        transcript: action.baseMessages,
        target: "character",
        phase: "用户刚刚回答完，主持人需要把问题抛回嘉宾",
        fallbackTargetCharacterId: action.fallbackTargetCharacterId,
      });
      if (!isInterviewRunCurrent(runId)) return;
      const targetCharacterId = nextQuestion.targetCharacterId || action.fallbackTargetCharacterId;
      const targetCharacterName = nextQuestion.targetCharacterName
        || characters.find((character) => character.id === targetCharacterId)?.name
        || "嘉宾";
      const withQuestion = [...action.baseMessages, makeInterviewMessage("host", nextQuestion.question, {
        kind: "question",
        target: "character",
        targetCharacterId,
        targetCharacterName,
      })];
      setMessages(withQuestion);
      await runCharacterAnswer(nextQuestion.question, withQuestion, action.nextRound, targetCharacterId, action.lastUserAnswer, action.currentTheme, runId);
    } catch (err) {
      if (!isInterviewRunCurrent(runId)) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
      setPendingLabel("");
    }
  };

  const composeArticle = async () => {
    if (selectedCharacterIds.length === 0 || messages.length === 0) return;
    const composeRunId = composeRunRef.current + 1;
    composeRunRef.current = composeRunId;
    setScreen("generating");
    setError("");
    try {
      const issueNumber = getNextInterviewIssueNumber();
      const result = await composeInterviewArticle({
        theme,
        characterIds: selectedCharacterIds,
        userIdentityId,
        transcript: messages,
        issueNumber,
      });
      if (composeRunRef.current !== composeRunId) return;
      const now = new Date().toISOString();
      const issue: InterviewIssue = {
        id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        issueNumber,
        theme,
        characterIds: result.context.guests.map((guest) => guest.character.id),
        characterNames: result.context.guestNames,
        characterId: result.context.character.id,
        characterName: result.context.guestListText,
        userName: result.context.userName,
        userIdentityId,
        guestSnapshots: result.context.guestSnapshots,
        characterSnapshot: result.context.characterSnapshot,
        userSnapshot: result.context.userSnapshot,
        worldBookSnapshot: result.context.worldBookSnapshot,
        transcript: messages,
        article: result.article,
        createdAt: now,
        updatedAt: now,
      };
      const savedIssues = saveInterviewIssue(issue);
      recordInterviewMagazineProjectionEvent({
        issueId: issue.id,
        issueNumber,
        title: issue.article.title,
        theme,
        characterIds: issue.characterIds || [issue.characterId],
        characterNames: issue.characterNames || [issue.characterName],
        userName: issue.userName,
        summary: issue.article.memorySummary || issue.article.subtitle,
        timestamp: now,
      });
      for (const guest of result.context.guests) {
        incrementEventCounter(guest.character.id);
        maybeRunSummarization(guest.character.id, guest.character.name).catch((summarizeError) => {
          console.warn("[InterviewMagazine] Summarization check failed:", summarizeError);
        });
      }
      setIssues(savedIssues);
      if (activeDraftId) {
        setDrafts(deleteInterviewDraft(activeDraftId));
        setActiveDraftId(null);
      }
      clearResumeAction();
      setActiveIssue(issue);
      setScreen("article");
    } catch (err) {
      if (composeRunRef.current !== composeRunId) return;
      setError(err instanceof Error ? err.message : String(err));
      setScreen("interview");
      setPhase("error");
    }
  };

  const cancelGenerating = () => {
    composeRunRef.current += 1;
    setScreen("interview");
  };

  const removeIssue = (issueId: string) => {
    deleteInterviewMagazineProjectionEventForIssue(issueId);
    setIssues(deleteInterviewIssue(issueId));
    if (activeIssue?.id === issueId) {
      setActiveIssue(null);
      setScreen("home");
    }
  };

  const removeDraft = (draftId: string) => {
    setDrafts(deleteInterviewDraft(draftId));
    if (activeDraftId === draftId) {
      resetDraft();
      setScreen("home");
    }
  };

  return (
    <div className="interview-app">
      <BackgroundLayer imageUrl={bgImageUrl} />
      <div className="interview-content">
        {screen === "setup" ? (
          <SetupScreen
            characters={characters}
            selectedCharacterIds={selectedCharacterIds}
            userIdentities={userIdentities}
            selectedUserIdentityId={userIdentityId}
            theme={theme}
            hostPrompt={hostPrompt}
            memoryPrompt={memoryPrompt}
            onThemeChange={setTheme}
            onCharacterToggle={toggleCharacter}
            onUserIdentityChange={setUserIdentityId}
            onHostPromptSave={(nextPrompt) => setHostPrompt(saveInterviewHostPrompt(nextPrompt))}
            onMemoryPromptSave={(nextPrompt) => setMemoryPrompt(saveInterviewMemoryPrompt(nextPrompt))}
            onBack={() => setScreen("home")}
            onStart={startInterview}
          />
        ) : screen === "interview" ? (
          <InterviewScreen
            theme={theme}
            characters={activeCharacters}
            messages={messages}
            phase={phase}
            pendingLabel={pendingLabel}
            userInput={userInput}
            error={error}
            canContinue={Boolean(resumeAction)}
            canWrap={messages.some((message) => message.role === "character")}
            maxCharacterTurns={maxCharacterTurns}
            scrollRef={scrollRef}
            onUserInputChange={setUserInput}
            onSubmitUserAnswer={submitUserAnswer}
            onContinue={continueInterview}
            onPause={pauseInterview}
            onWrap={composeArticle}
            onAbort={exitInterviewToHome}
          />
        ) : screen === "generating" ? (
          <GeneratingScreen onBack={cancelGenerating} />
        ) : screen === "article" && activeIssue ? (
          <ArticleScreen
            issue={activeIssue}
            onBack={() => {
              setActiveIssue(null);
              resetDraft();
              setScreen("home");
            }}
          />
        ) : (
          <HomeScreen
            issues={issues}
            drafts={drafts}
            onClose={onClose}
            onNewIssue={() => setScreen("setup")}
            onOpenDraft={openDraft}
            onOpenIssue={(issue) => {
              setActiveIssue(issue);
              setScreen("article");
            }}
            onDeleteDraft={removeDraft}
            onDeleteIssue={removeIssue}
          />
        )}
      </div>
    </div>
  );
}

function HomeScreen({
  issues,
  drafts,
  onClose,
  onNewIssue,
  onOpenDraft,
  onOpenIssue,
  onDeleteDraft,
  onDeleteIssue,
}: {
  issues: InterviewIssue[];
  drafts: InterviewDraft[];
  onClose: () => void;
  onNewIssue: () => void;
  onOpenDraft: (draft: InterviewDraft) => void;
  onOpenIssue: (issue: InterviewIssue) => void;
  onDeleteDraft: (draftId: string) => void;
  onDeleteIssue: (issueId: string) => void;
}) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pendingDeleteDraft, setPendingDeleteDraft] = useState<InterviewDraft | null>(null);
  const [pendingDeleteIssue, setPendingDeleteIssue] = useState<InterviewIssue | null>(null);
  const nextIssueNumber = useMemo(
    () => issues.reduce((largest, issue) => Math.max(largest, issue.issueNumber || 0), 0) + 1,
    [issues],
  );

  return (
    <>
      <header className="interview-header">
        <button className="interview-icon-btn" onClick={onClose} aria-label="返回桌面">
          <ChevronLeft size={20} />
        </button>
        <SmallCaps className="text-white/70 tracking-widest">The Interview</SmallCaps>
        <button className="interview-icon-btn" onClick={() => setArchiveOpen(true)} aria-label="查看往期">
          <Menu size={20} />
        </button>
      </header>

      <main className="interview-scroll px-6 pb-32">
        <section className="text-center py-10 fade-in">
          <div className="flex items-center justify-center gap-4 text-white/40 mb-4">
            <span className="w-10 h-px bg-white/20"></span>
            <SmallCaps>ISSUE NO.{String(nextIssueNumber).padStart(2, "0")}</SmallCaps>
            <span className="w-10 h-px bg-white/20"></span>
          </div>
          <h1 className="font-display text-5xl font-black text-white tracking-wider my-4 drop-shadow-md">
            PRESENCE
          </h1>
          <p className="font-cn text-white/60 tracking-[0.4em] ml-[0.4em] font-light">
            在场 · 人物特写
          </p>
        </section>

        {drafts.length > 0 && (
          <section className="mt-4 mb-10 fade-in" style={{ animationDelay: '0.05s' }}>
            <div className="flex items-center justify-between mb-4 px-2">
              <SmallCaps className="text-white/60">UNFINISHED // 未完成录制</SmallCaps>
              <span className="text-white/40 text-xs font-serif">{drafts.length} 条</span>
            </div>
            <div className="flex flex-col gap-4">
              {drafts.map((draft) => (
                <article key={draft.id} className="interview-glass-panel interview-glass-panel-hover p-5 relative group overflow-hidden border-white/15">
                  <button type="button" className="w-full text-left" onClick={() => onOpenDraft(draft)}>
                    <div className="flex items-center gap-2 mb-3">
                      <SmallCaps className="text-white/70">{getDraftStatusText(draft.status)}</SmallCaps>
                      <span className="text-white/20 text-xs">|</span>
                      <SmallCaps className="text-white/50">{new Date(draft.updatedAt).toLocaleDateString("zh-CN")}</SmallCaps>
                    </div>
                    <h2 className="font-display text-xl font-bold text-white/95 mb-2 leading-tight">
                      {draft.theme}
                    </h2>
                    <p className="font-serif italic text-white/60 text-sm line-clamp-2">
                      {draft.status === "error" ? (draft.error || "API 返回错误，等待继续录制。") : "录制已保存，可从当前位置继续。"}
                    </p>
                    <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between">
                      <span className="text-white/40 text-xs">GUESTS: {getDraftParticipantText(draft)}</span>
                      <span className="inline-flex items-center gap-1 text-white/50 text-xs">
                        继续 <ChevronRight size={14} />
                      </span>
                    </div>
                  </button>
                  <button
                    className="absolute top-4 right-4 p-2 -m-2 text-white/30 hover:text-red-400/80 active:text-red-500 transition-colors z-10"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingDeleteDraft(draft);
                    }}
                    aria-label="删除未完成录制"
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="mt-4 mb-10 fade-in" style={{ animationDelay: '0.1s' }}>
          <div className="flex items-center justify-between mb-4 px-2">
            <SmallCaps className="text-white/50">ARCHIVES // 往期专栏</SmallCaps>
            <span className="text-white/40 text-xs font-serif">{issues.length} 期</span>
          </div>

          {issues.length === 0 ? (
            <div className="interview-glass-panel flex flex-col items-center justify-center p-8 text-center min-h-[140px]">
              <Mic2 size={24} className="text-white/30 mb-3" strokeWidth={1.5} />
              <p className="font-serif italic text-white/40 text-sm">Waiting for the first interview.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {issues.map((issue) => (
                <article key={issue.id} className="interview-glass-panel interview-glass-panel-hover p-5 relative group overflow-hidden">
                  <button type="button" className="w-full text-left" onClick={() => onOpenIssue(issue)}>
                    <div className="flex items-center gap-2 mb-3">
                      <SmallCaps className="text-white/60">NO.{String(issue.issueNumber).padStart(2, "0")}</SmallCaps>
                      <span className="text-white/20 text-xs">|</span>
                      <SmallCaps className="text-white/60">{issue.theme}</SmallCaps>
                    </div>
                    <h2 className="font-display text-xl font-bold text-white/95 mb-2 leading-tight">
                      {issue.article.title}
                    </h2>
                    <p className="font-serif italic text-white/60 text-sm line-clamp-2">
                      {issue.article.subtitle}
                    </p>
                    <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between">
                      <span className="text-white/40 text-xs">GUESTS: {getIssueParticipantText(issue)}</span>
                      <ChevronRight size={14} className="text-white/30" />
                    </div>
                  </button>
                  <button
                    className="absolute top-4 right-4 p-2 -m-2 text-white/30 hover:text-red-400/80 active:text-red-500 transition-colors z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteIssue(issue);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <div className="absolute bottom-10 right-6 z-20">
        <button
          className="w-14 h-14 rounded-full flex items-center justify-center bg-white/10 backdrop-blur-md border border-white/20 text-white shadow-lg hover:bg-white/20 hover:scale-105 transition-all"
          onClick={onNewIssue}
        >
          <Plus size={24} strokeWidth={1.5} />
        </button>
      </div>

      {archiveOpen && (
        <>
          <div className="interview-modal-scrim" onClick={() => setArchiveOpen(false)} />
          <div className="interview-drawer">
            <header className="p-6 pb-4 border-b border-white/10 flex items-center justify-between">
              <div>
                <SmallCaps className="text-white/50">ARCHIVES</SmallCaps>
                <div className="text-white/90 font-medium mt-1">往期专访</div>
              </div>
              <button className="interview-icon-btn" onClick={() => setArchiveOpen(false)}>
                <X size={20} />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {issues.map((issue) => (
                <div key={issue.id} className="interview-glass-panel p-4 flex flex-col gap-2">
                  <button className="text-left w-full" onClick={() => { setArchiveOpen(false); onOpenIssue(issue); }}>
                    <SmallCaps className="text-white/50">NO.{String(issue.issueNumber).padStart(2, "0")} · {issue.theme}</SmallCaps>
                    <h3 className="text-white/90 font-display font-bold mt-1 mb-2">{issue.article.title}</h3>
                    <div className="text-white/40 text-xs">GUESTS // {getIssueParticipantText(issue)}</div>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {pendingDeleteDraft && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-6">
          <div className="interview-modal-scrim" onClick={() => setPendingDeleteDraft(null)} />
          <div className="interview-glass-panel p-6 w-full max-w-sm relative z-50 fade-in">
            <SmallCaps className="text-red-300/80 mb-2">DELETE DRAFT</SmallCaps>
            <h2 className="text-xl font-medium text-white mb-3">删除未完成录制？</h2>
            <p className="text-white/60 text-sm mb-6 leading-relaxed">
              “{pendingDeleteDraft.theme}” 的采访草稿将被移除，已有实录不会成刊。
            </p>
            <div className="flex gap-3 justify-end">
              <button className="px-4 py-2 rounded-full border border-white/10 text-white/70 hover:bg-white/5 text-sm" onClick={() => setPendingDeleteDraft(null)}>取消</button>
              <button className="px-4 py-2 rounded-full bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 text-sm" onClick={() => { onDeleteDraft(pendingDeleteDraft.id); setPendingDeleteDraft(null); }}>删除</button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteIssue && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-6">
          <div className="interview-modal-scrim" onClick={() => setPendingDeleteIssue(null)} />
          <div className="interview-glass-panel p-6 w-full max-w-sm relative z-50 fade-in">
            <SmallCaps className="text-red-300/80 mb-2">DELETE ISSUE</SmallCaps>
            <h2 className="text-xl font-medium text-white mb-3">删除这期刊物？</h2>
            <p className="text-white/60 text-sm mb-6 leading-relaxed">
              《{pendingDeleteIssue.article.title}》将从往期中移除，删除后无法恢复。
            </p>
            <div className="flex gap-3 justify-end">
              <button className="px-4 py-2 rounded-full border border-white/10 text-white/70 hover:bg-white/5 text-sm" onClick={() => setPendingDeleteIssue(null)}>取消</button>
              <button className="px-4 py-2 rounded-full bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 text-sm" onClick={() => { onDeleteIssue(pendingDeleteIssue.id); setPendingDeleteIssue(null); }}>删除</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SetupScreen({
  characters,
  selectedCharacterIds,
  userIdentities,
  selectedUserIdentityId,
  theme,
  hostPrompt,
  memoryPrompt,
  onThemeChange,
  onCharacterToggle,
  onUserIdentityChange,
  onHostPromptSave,
  onMemoryPromptSave,
  onBack,
  onStart,
}: {
  characters: Character[];
  selectedCharacterIds: string[];
  userIdentities: UserIdentity[];
  selectedUserIdentityId: string;
  theme: string;
  hostPrompt: string;
  memoryPrompt: string;
  onThemeChange: (value: string) => void;
  onCharacterToggle: (value: string) => void;
  onUserIdentityChange: (value: string) => void;
  onHostPromptSave: (value: string) => void;
  onMemoryPromptSave: (value: string) => void;
  onBack: () => void;
  onStart: () => void;
}) {
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [draftHostPrompt, setDraftHostPrompt] = useState(hostPrompt);
  const [draftMemoryPrompt, setDraftMemoryPrompt] = useState(memoryPrompt);
  const ready = characters.length > 0 && selectedCharacterIds.length > 0 && theme.trim().length > 0;

  return (
    <>
      <header className="interview-header">
        <button className="interview-icon-btn" onClick={onBack}>
          <ChevronLeft size={20} />
        </button>
        <div className="text-center">
          <SmallCaps className="text-white/50">PREP NEW ISSUE</SmallCaps>
          <div className="text-white font-medium">策划本期专访</div>
        </div>
        <button className="interview-icon-btn" onClick={() => { setDraftHostPrompt(hostPrompt); setDraftMemoryPrompt(memoryPrompt); setPromptEditorOpen(true); }}>
          <PencilLine size={18} />
        </button>
      </header>

      <main className="interview-scroll px-5 py-6 flex flex-col gap-8">
        <section className="fade-in">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-white/30 text-xs font-mono">01</span>
            <SmallCaps className="text-white/60">GUESTS // 受访嘉宾</SmallCaps>
          </div>
          <div className="flex flex-col gap-3">
            {characters.map((character) => {
              const active = selectedCharacterIds.includes(character.id);
              return (
                <button
                  key={character.id}
                  className={`interview-glass-panel p-4 text-left transition-all ${active ? 'border-white/70 bg-white/[0.13] shadow-[0_0_0_1px_rgba(255,255,255,0.28),0_6px_22px_rgba(255,255,255,0.07)]' : 'opacity-60 hover:opacity-100'}`}
                  onClick={() => onCharacterToggle(character.id)}
                >
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-base font-medium text-white">{character.name}</span>
                    <SmallCaps className={active ? "text-white tracking-[0.18em]" : "text-white/40"}>
                      {active ? "● SELECTED" : "TAP TO SELECT"}
                    </SmallCaps>
                  </div>
                  <p className="text-xs text-white/50 line-clamp-1">{character.personality || character.persona || "嘉宾"}</p>
                </button>
              );
            })}
          </div>
        </section>

        <section className="fade-in" style={{ animationDelay: '0.1s' }}>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-white/30 text-xs font-mono">02</span>
            <SmallCaps className="text-white/60">CO-HOST // 共同受访身份</SmallCaps>
          </div>
          <select
            className="interview-glass-input w-full px-4 py-3 appearance-none focus:outline-none"
            value={selectedUserIdentityId}
            onChange={(e) => onUserIdentityChange(e.target.value)}
          >
            {userIdentities.length === 0 ? (
              <option value="" className="bg-stone-900">未绑定身份</option>
            ) : userIdentities.map((id) => (
              <option key={id.id} value={id.id} className="bg-stone-900 text-white">{id.name}</option>
            ))}
          </select>
        </section>

        <section className="fade-in" style={{ animationDelay: '0.2s' }}>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-white/30 text-xs font-mono">03</span>
            <SmallCaps className="text-white/60">THEME // 本期主题</SmallCaps>
          </div>
          <input
            className="interview-glass-input w-full px-5 py-4 text-lg mb-4"
            value={theme}
            onChange={(e) => onThemeChange(e.target.value)}
            placeholder="输入采访主题..."
          />
          <div className="flex flex-wrap gap-2">
            {THEME_CHIPS.map(chip => {
              const chipActive = theme === chip;
              return (
                <button
                  key={chip}
                  className={`px-3 py-1.5 rounded-full border text-sm transition-colors ${chipActive ? 'border-white/70 bg-white/15 text-white shadow-[0_0_0_1px_rgba(255,255,255,0.25)]' : 'border-white/10 text-white/60 hover:bg-white/10 hover:text-white'}`}
                  onClick={() => onThemeChange(chip)}
                >
                  {chip}
                </button>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="interview-bottom-bar">
        <button
          className="interview-primary-btn w-full"
          disabled={!ready}
          onClick={onStart}
        >
          <Radio size={16} className={ready ? "text-white" : "text-white/40"} />
          <span className={ready ? "text-white font-medium" : "text-white/40"}>BEGIN RECORDING // 开始录制</span>
        </button>
      </footer>

      {promptEditorOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-6">
          <div className="interview-modal-scrim" onClick={() => setPromptEditorOpen(false)} />
          <div className="relative w-full max-w-lg h-[75vh] interview-glass-panel p-6 flex flex-col z-50 fade-in bg-[#111]/80">
            <header className="flex justify-between items-center mb-6">
              <div>
                <SmallCaps className="text-white/50">EDITOR PROMPTS</SmallCaps>
                <div className="text-white text-lg mt-1">提示词设置</div>
              </div>
              <button className="interview-icon-btn" onClick={() => setPromptEditorOpen(false)}><X size={20} /></button>
            </header>
            <div className="flex-1 overflow-y-auto flex flex-col gap-6">
              <div className="flex flex-col flex-1">
                <SmallCaps className="text-white/50 mb-2 block flex-shrink-0">HOST PROMPT // 主持人设定</SmallCaps>
                <textarea
                  className="interview-glass-panel !rounded-xl focus:bg-white/[0.08] focus:border-white/25 focus:outline-none transition-all w-full p-4 flex-1 resize-none text-[calc(11px*var(--app-text-scale,1))] leading-relaxed"
                  value={draftHostPrompt}
                  onChange={(e) => setDraftHostPrompt(e.target.value)}
                />
              </div>
              <div className="flex flex-col flex-1">
                <SmallCaps className="text-white/50 mb-2 block flex-shrink-0">MEMORY // 短期记忆</SmallCaps>
                <textarea
                  className="interview-glass-panel !rounded-xl focus:bg-white/[0.08] focus:border-white/25 focus:outline-none transition-all w-full p-4 flex-1 resize-none text-[calc(11px*var(--app-text-scale,1))] leading-relaxed"
                  value={draftMemoryPrompt}
                  onChange={(e) => setDraftMemoryPrompt(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-white/10">
              <button className="px-5 py-2.5 rounded-full border border-white/10 text-white/70 text-sm" onClick={() => setPromptEditorOpen(false)}>取消</button>
              <button className="px-5 py-2.5 rounded-full bg-white/10 border border-white/20 text-white text-sm font-medium" onClick={() => { onHostPromptSave(draftHostPrompt); onMemoryPromptSave(draftMemoryPrompt); setPromptEditorOpen(false); }}>保存设置</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function InterviewScreen({
  theme,
  characters,
  messages,
  phase,
  pendingLabel,
  userInput,
  error,
  canContinue,
  canWrap,
  maxCharacterTurns,
  scrollRef,
  onUserInputChange,
  onSubmitUserAnswer,
  onContinue,
  onPause,
  onWrap,
  onAbort,
}: {
  theme: string;
  characters: Character[];
  messages: InterviewMessage[];
  phase: InterviewPhase;
  pendingLabel: string;
  userInput: string;
  error: string;
  canContinue: boolean;
  canWrap: boolean;
  maxCharacterTurns: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onUserInputChange: (value: string) => void;
  onSubmitUserAnswer: () => void;
  onContinue: () => void;
  onPause: () => void;
  onWrap: () => void;
  onAbort: () => void;
}) {
  const characterNameById = useMemo(
    () => Object.fromEntries(characters.map((c) => [c.id, c.name])),
    [characters],
  );
  const guestLabel = characters.map(c => c.name).join("、") || "嘉宾";
  const turns = messages.filter(m => m.role === 'character').length;

  return (
    <>
      <header className="interview-header backdrop-blur-md bg-black/20">
        <button className="interview-icon-btn" onClick={onAbort}>
          <X size={20} />
        </button>
        <div className="flex flex-col items-center">
          <SmallCaps className="text-white/60 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
            ON AIR // 录制中
          </SmallCaps>
          <div className="text-white text-xs opacity-50 font-mono mt-1">ROUND {turns}/{maxCharacterTurns}</div>
        </div>
        <div className="w-10"></div>
      </header>

      <main className="interview-scroll px-4 pt-6 pb-32 scroll-smooth" ref={scrollRef}>
        <div className="text-center mb-10 fade-in">
          <SmallCaps className="text-white/40">EPISODE // 本期</SmallCaps>
          <h2 className="text-2xl text-white/90 font-bold mt-2 mb-2">{theme}</h2>
          <div className="text-xs text-white/30 font-mono">GUEST: {guestLabel}</div>
          <div className="w-12 h-px bg-white/20 mx-auto mt-6"></div>
        </div>

        <div className="flex flex-col gap-6">
          {messages.map((message) => {
            const isHost = message.role === "host";
            const isSpecial = message.kind === "intro" || message.kind === "outro";
            const speakerName = message.speakerName || (message.speakerCharacterId ? characterNameById[message.speakerCharacterId] : null) || guestLabel;

            if (isHost) {
              return (
                <div key={message.id} className="py-6 my-2 border-y border-white/5 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent flex flex-col items-center text-center">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-1.5 h-1.5 bg-white/30 rotate-45"></span>
                    <SmallCaps className="text-white/40 tracking-widest">{isSpecial ? `NARRATOR // 旁白` : `HOST // ${INTERVIEW_MAGAZINE_HOST_NAME}`}</SmallCaps>
                    <span className="w-1.5 h-1.5 bg-white/30 rotate-45"></span>
                  </div>
                  <p className={`text-[calc(16px*var(--app-text-scale,1))] leading-relaxed max-w-[90%] mx-auto ${isSpecial ? 'text-white/50 italic font-serif' : 'text-white/80 font-medium'}`}>
                    {message.content}
                  </p>
                  {message.kind === "question" && (
                    <div className="mt-4 text-[calc(11px*var(--app-text-scale,1))] font-mono text-white/30 border border-white/10 rounded-full px-3 py-1 flex items-center gap-2">
                      <span className="w-1 h-1 rounded-full bg-white/30"></span>
                      TARGET ▹ {message.target === "user" ? "YOU" : message.targetCharacterName?.toUpperCase() || "GUEST"}
                    </div>
                  )}
                </div>
              );
            }

            const isUser = message.role === "user";

            return (
              <div key={message.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                <div className={`interview-glass-panel p-4 max-w-[85%] ${isUser ? 'bg-white/10 border-white/20' : 'bg-white/5 border-white/10'}`}>
                  <SmallCaps className={`mb-1 block ${isUser ? 'text-white/40 text-right' : 'text-white/60'}`}>
                    {isUser ? 'YOU // 共同受访' : `[ ${speakerName.toUpperCase()} ]`}
                  </SmallCaps>
                  <p className="text-[calc(15px*var(--app-text-scale,1))] leading-relaxed text-white/90 whitespace-pre-wrap">
                    {message.content}
                  </p>
                </div>
              </div>
            );
          })}

          {(phase === "opening" || phase === "host" || phase === "character") && (
            <div className="interview-typing flex items-center gap-3 py-4 text-white/40 text-sm">
              <span className="font-mono text-xs">{pendingLabel || "WAITING"}</span>
              <span><i></i><i></i><i></i></span>
            </div>
          )}

          {phase === "paused" && (
            <div className="interview-glass-panel p-4 bg-white/10 border-white/20 text-white/80">
              <div className="font-bold text-sm mb-1">PAUSED // 录制已暂停</div>
              <p className="text-xs opacity-70">点击下方继续按钮，从中断位置接着录制。</p>
            </div>
          )}

          {phase === "error" && (
            <div className="interview-glass-panel p-4 bg-red-900/30 border-red-500/30 text-red-200">
              <div className="font-bold text-sm mb-1">INTERRUPTED // 录制中断</div>
              <p className="text-xs opacity-80">{error}</p>
            </div>
          )}
        </div>
      </main>

      <footer className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black via-black/80 to-transparent">
        {phase === "user" ? (
          <div className="flex flex-col gap-3">
            <div className="interview-glass-input rounded-full p-1.5 flex items-center bg-black/40 border-white/15">
              <textarea
                className="flex-1 bg-transparent border-none text-white text-[calc(15px*var(--app-text-scale,1))] px-4 py-2 max-h-24 resize-none focus:outline-none focus:ring-0 placeholder-white/30"
                rows={1}
                value={userInput}
                onChange={(e) => onUserInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSubmitUserAnswer();
                  }
                }}
                placeholder="发送回应..."
              />
              <button
                className={`w-10 h-10 rounded-full flex items-center justify-center transition-all flex-shrink-0 ${userInput.trim() ? 'bg-white text-black' : 'bg-white/10 text-white/30'}`}
                disabled={!userInput.trim()}
                onClick={onSubmitUserAnswer}
              >
                <Send size={16} className={userInput.trim() ? "ml-0.5" : ""} />
              </button>
            </div>
            {canWrap && (
              <button className="text-xs font-mono text-white/40 hover:text-white/80 py-1 text-center transition-colors" onClick={onWrap}>
                [ 提前结稿 // WRAP NOW ]
              </button>
            )}
          </div>
        ) : phase === "done" ? (
          <button className="interview-primary-btn w-full bg-white text-black border-transparent shadow-[0_0_20px_rgba(255,255,255,0.3)]" onClick={onWrap}>
            <Sparkles size={16} />
            <span className="font-bold">结稿成刊 // COMPOSE ARTICLE</span>
          </button>
        ) : phase === "paused" ? (
          <div className="flex flex-col gap-3">
            <button className="interview-primary-btn w-full bg-white text-black border-transparent shadow-[0_0_20px_rgba(255,255,255,0.22)]" onClick={onContinue}>
              <Radio size={16} />
              <span className="font-bold">继续录制 // CONTINUE</span>
            </button>
            {canWrap ? (
              <button className="text-xs font-mono text-white/40 hover:text-white/80 py-1 text-center transition-colors" onClick={onWrap}>
                [ 保留实录并成刊 // WRAP NOW ]
              </button>
            ) : null}
          </div>
        ) : phase === "error" ? (
          <div className="flex flex-col gap-3">
            {canContinue ? (
              <button className="interview-primary-btn w-full bg-white text-black border-transparent shadow-[0_0_20px_rgba(255,255,255,0.22)]" onClick={onContinue}>
                <Radio size={16} />
                <span className="font-bold">继续录制 // CONTINUE</span>
              </button>
            ) : null}
            {canWrap ? (
              <button className="interview-primary-btn w-full bg-red-500/20 text-red-100 border-red-500/30" onClick={onWrap}>
                <span>保留实录并成刊</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="h-14 flex items-center justify-center">
            <button
              className="interview-pulse-glow w-14 h-14 rounded-full flex items-center justify-center bg-white/10 border border-white/20 text-white/70 backdrop-blur-md transition-all active:scale-95"
              onClick={onPause}
              aria-label="暂停录制"
              title="暂停录制"
            >
              <Pause size={18} />
            </button>
          </div>
        )}
      </footer>
    </>
  );
}

function GeneratingScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/60 backdrop-blur-2xl">
      <div className="flex flex-col items-center text-center fade-in relative z-50 p-8 interview-glass-panel w-4/5 max-w-sm">
        <Loader2 size={32} className="interview-spin text-white/80 mb-6" />
        <SmallCaps className="text-white/40 mb-2">COMPOSING ISSUE</SmallCaps>
        <div className="font-display text-2xl text-white font-bold tracking-widest mb-2">IN PRESS</div>
        <p className="text-white/50 text-sm">正在整理实录与排版，请稍候...</p>
        <button className="mt-8 text-white/30 text-xs font-mono hover:text-white/60 transition-colors" onClick={onBack}>
          [ CANCEL // 取消 ]
        </button>
      </div>
    </div>
  );
}

function ArticleScreen({
  issue,
  onBack,
}: {
  issue: InterviewIssue;
  onBack: () => void;
}) {
  const guestNames = getIssueGuestNames(issue);
  const guestLabel = guestNames.join("、") || issue.characterName;

  return (
    <div className="absolute inset-0 bg-[#0a0a0a] z-40 overflow-hidden flex flex-col">
      <header className="interview-header bg-black/50 backdrop-blur-md absolute top-0 left-0 right-0 z-10">
        <button className="w-10 h-10 flex items-center justify-center text-white/60 hover:text-white transition-colors" onClick={onBack}>
          <ChevronLeft size={22} />
        </button>
        <SmallCaps className="text-white/40 tracking-widest">ISSUE NO.{String(issue.issueNumber).padStart(2, "0")}</SmallCaps>
        <div className="w-10"></div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 pt-24 pb-32">
        <article className="max-w-2xl mx-auto">
          <div className="text-center mb-12 fade-in">
            <SmallCaps className="text-white/30 mb-6 block">PRESENCE // THE INTERVIEW</SmallCaps>
            <h1 className="font-display text-3xl md:text-4xl text-white/95 font-bold leading-tight mb-4">
              {issue.article.title}
            </h1>
            <p className="font-serif italic text-white/60 text-lg mb-8">
              {issue.article.subtitle}
            </p>
            <div className="flex items-center justify-center gap-3">
              <span className="w-8 h-px bg-white/20"></span>
              <span className="text-white/40 text-xs font-mono tracking-widest">GUEST: {guestLabel}</span>
              <span className="w-8 h-px bg-white/20"></span>
            </div>
          </div>

          <div className="space-y-6 text-white/80 font-cn text-[calc(15px*var(--app-text-scale,1))] leading-loose fade-in" style={{ animationDelay: '0.2s' }}>
            {issue.article.body.map((p, i) => (
              <p key={i} className={i === 0 ? "first-letter:text-4xl first-letter:font-display first-letter:float-left first-letter:mr-2 first-letter:text-white" : ""}>
                {p}
              </p>
            ))}
          </div>

          {issue.article.pullQuote && (
            <div className="my-14 py-8 border-y border-white/10 text-center relative">
              <span className="absolute -top-4 left-1/2 -translate-x-1/2 bg-[#0a0a0a] px-4 text-white/20 text-2xl font-serif">"</span>
              <p className="font-serif italic text-white/90 text-xl leading-relaxed">
                {issue.article.pullQuote}
              </p>
              <SmallCaps className="text-white/40 mt-6 block">— {issue.characterName}</SmallCaps>
            </div>
          )}

          {issue.article.qa.length > 0 && (
            <div className="mt-16">
              <div className="flex items-center gap-4 mb-8">
                <h2 className="font-display italic text-2xl text-white/90">Q&A</h2>
                <div className="flex-1 h-px bg-white/10"></div>
                <SmallCaps className="text-white/30">PRECISION CUTS</SmallCaps>
              </div>
              <div className="space-y-8">
                {issue.article.qa.map((qa, i) => (
                  <div key={i} className="interview-glass-panel p-6 border-white/5 bg-white/[0.02]">
                    <div className="flex gap-4 mb-3">
                      <span className="font-display font-bold text-white/60">Q.</span>
                      <p className="text-white/90 font-medium leading-relaxed">{qa.q}</p>
                    </div>
                    <div className="flex gap-4">
                      <span className="font-display italic text-white/40">A.</span>
                      <p className="text-white/70 leading-relaxed">{qa.a}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-16 pt-8 border-t border-white/5">
            <SmallCaps className="text-white/30 mb-4 block">TRANSCRIPT // 原始访谈实录</SmallCaps>
            <details className="group">
              <summary className="text-white/40 text-sm font-mono hover:text-white/70 transition-colors cursor-pointer flex items-center gap-2 outline-none select-none">
                <ChevronRight size={16} className="group-open:rotate-90 transition-transform" />
                [ VIEW FULL TRANSCRIPT ]
              </summary>
              <pre className="mt-6 p-6 interview-glass-panel bg-white/[0.02] border-white/5 text-white/60 text-[calc(13px*var(--app-text-scale,1))] whitespace-pre-wrap font-cn leading-relaxed overflow-x-hidden">
                {formatInterviewTranscript(issue.transcript, issue.characterName, issue.userName, getIssueCharacterNameMap(issue))}
              </pre>
            </details>
          </div>

          <div className="mt-20 pt-8 border-t border-white/10 text-center">
            <SmallCaps className="text-white/30 block mb-2">END // 完</SmallCaps>
            <div className="text-white/20 text-xs font-mono">{new Date(issue.createdAt).toLocaleDateString("en-US")}</div>
          </div>
        </article>
      </main>
    </div>
  );
}

export default InterviewMagazineApp;
