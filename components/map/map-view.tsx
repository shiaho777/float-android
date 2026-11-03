"use client";
import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { ArrowLeft, BookOpen, LogOut, Bug, Map as MapIcon, MessageCircle, Save, Send, Palette, MoreHorizontal, X } from "lucide-react";
import type { MapWorld, GameSave, NodeInteraction, EventScene, EventChoice, StreamMessage, Declaration } from "@/lib/map-types";
import {
  saveGame,
  loadWorldTheme,
  saveWorldTheme,
  type WorldTheme,
  loadAdventureInteractionConfig,
} from "@/lib/map-storage";
import { ADVENTURE_THEMES } from "./map-text-stream";
import { loadCharacters } from "@/lib/character-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity, resolveAuxiliaryApiConfig } from "@/lib/settings-storage";
import { expandEvent, companionDeclare, resolveRound, rollD100, ROLL_LABELS, formatGameTime, pickEncounter, shouldTriggerEncounter, setDMDebugCallback, shouldAutoSummarize, generateAdventureSummary, generateEnding, type EndingResult, DEFAULT_DM_ENDING_PROMPT } from "@/lib/map-rpg-engine";
import { STAT_LABELS, ALL_STATS } from "@/lib/map-types";
import MapRenderer from "./map-renderer";
import MapTextStream from "./map-text-stream";

type Props = {
  world: MapWorld;
  save: GameSave;
  onSaveUpdate: (save: GameSave) => void;
  onBack: () => void;
};

export default function MapView({ world, save, onSaveUpdate, onBack }: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showJournal, setShowJournal] = useState(false);
  const [activeEvent, setActiveEvent] = useState<EventScene | null>(null);
  const [eventLoading, setEventLoading] = useState(false);
  const [activeEventMeta, setActiveEventMeta] = useState<{ type: string; questId?: string } | null>(save.pendingEvent?.eventMeta || null);
  const [eventContext, setEventContext] = useState(save.pendingEvent?.eventContext || "");
  const [eventContinueLoading, setEventContinueLoading] = useState(false);
  const [loadingPhase, setLoadingPhase_] = useState<"" | "companions" | "dm">("");
  const loadingPhaseRef = useRef(loadingPhase);
  const setLoadingPhase = useCallback((v: "" | "companions" | "dm") => { loadingPhaseRef.current = v; setLoadingPhase_(v); }, []);
  const [accumulatedEvent, setAccumulatedEvent] = useState<EventScene | null>(null);
  // showContacts removed — contacts now in tool panel
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugLog, setDebugLog] = useState<{ time: string; type: string; content: string }[]>([]);
  const [debugFilter, setDebugFilter] = useState<"current" | "dm" | "char" | "all">("current");
  const [worldEvents, setWorldEvents] = useState<string[]>([]);
  const [showWorldEvents, setShowWorldEvents] = useState(false);
  const [showDeathDialog, setShowDeathDialog] = useState(false);
  const [endingData, setEndingData] = useState<EndingResult | null>(null);
  const [endingStep, setEndingStep] = useState(0);  // 0..paragraphs.length = paragraphs, +1 = closing, +2 = fireworks
  const [showFireworks, setShowFireworks] = useState(false);

  // New text-centric states
  const [streamMessages, setStreamMessages] = useState<StreamMessage[]>(save.streamLog || []);
  const [showToolPanel, setShowToolPanel] = useState(false);
  const [toolTab, setToolTab] = useState<"map" | "contacts" | "bag">("map");
  const [inEvent, setInEvent] = useState(save.pendingEvent?.inEvent || false);
  const [currentChoices, setCurrentChoices] = useState<EventChoice[] | null>(save.pendingEvent?.choices || null);
  const [freeText, setFreeText] = useState("");
  const [freeAction, setFreeAction] = useState("");
  const [diceOverlay, setDiceOverlay] = useState<{ name: string; stat: string; statValue: number; context: string; label: string; isPlayer: boolean } | null>(null);
  const [diceRolling, setDiceRolling] = useState(false);
  const [diceNumber, setDiceNumber] = useState(0);
  const [diceWaitingClick, setDiceWaitingClick] = useState(false);
  const diceResolveRef = useRef<((r: { roll: number; level: string }) => void) | null>(null);
  const [pickerOverlay, setPickerOverlay] = useState<{ candidates: string[]; current: string; chosen: string; settled: boolean } | null>(null);
  const [lastFailedEvent, setLastFailedEvent] = useState<{ type: string; brief: string; meta?: { questId?: string; npcName?: string; npcPersonality?: string } } | null>(null);
  const [lastFailedAction, setLastFailedAction] = useState<string | null>(save.pendingEvent?.lastAction || null);
  const [completedCompanions, setCompletedCompanions] = useState<string[]>(save.pendingEvent?.completedCompanions || []);
  const completedCompanionsRef = useRef(completedCompanions);
  completedCompanionsRef.current = completedCompanions;
  const [freeMode, setFreeMode] = useState(false);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [freeModeReplying, setFreeModeReplying] = useState(false);
  const [worldTheme, setWorldTheme] = useState<WorldTheme>(() => loadWorldTheme(world.id));
  const [adventureConfig, setAdventureConfig] = useState(() => loadAdventureInteractionConfig());
  const [showThemePanel, setShowThemePanel] = useState(false);
  const [showTopActionMenu, setShowTopActionMenu] = useState(false);
  const [showEventActionDrawer, setShowEventActionDrawer] = useState(false);
  const [customFontFamily, setCustomFontFamily] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const endingScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll ending overlay when step changes
  useEffect(() => {
    if (endingScrollRef.current) {
      endingScrollRef.current.scrollTop = endingScrollRef.current.scrollHeight;
    }
  }, [endingStep]);

  // Stream message helpers
  const nextMsgId = useRef(0);
  const mkId = () => `sm_${Date.now()}_${nextMsgId.current++}`;
  const streamRef = useRef(streamMessages);
  streamRef.current = streamMessages;
  const pushMessages = useCallback((...msgs: StreamMessage[]) => {
    setStreamMessages(prev => [...prev, ...msgs]);
  }, []);

  // Refs for event state (used by persistSave to avoid stale closures)
  const inEventRef = useRef(inEvent);
  inEventRef.current = inEvent;
  const currentChoicesRef = useRef(currentChoices);
  currentChoicesRef.current = currentChoices;
  const eventContextRef = useRef(eventContext);
  eventContextRef.current = eventContext;
  const activeEventMetaRef = useRef(activeEventMeta);
  activeEventMetaRef.current = activeEventMeta;
  const lastFailedActionRef = useRef(lastFailedAction);
  lastFailedActionRef.current = lastFailedAction;
  const saveRef = useRef(save);
  React.useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // Unified save: always injects streamLog + pendingEvent from refs
  const persistSave = useCallback((newSave: GameSave) => {
    const withExtra: GameSave = {
      ...newSave,
      streamLog: streamRef.current.slice(-200),
      pendingEvent: inEventRef.current ? {
        inEvent: true,
        choices: currentChoicesRef.current || undefined,
        eventContext: eventContextRef.current || undefined,
        eventMeta: activeEventMetaRef.current || undefined,
        lastAction: lastFailedActionRef.current || undefined,
        interruptedPhase: loadingPhaseRef.current || undefined,
        completedCompanions: completedCompanionsRef.current.length > 0 ? completedCompanionsRef.current : undefined,
      } : undefined,
    };
    saveRef.current = withExtra;
    saveGame(withExtra);
    onSaveUpdate(withExtra);
  }, [onSaveUpdate]);

  // Inject custom font via FontFace API (avoids CSS string length / quoting issues with data URLs)
  React.useEffect(() => {
    if (!worldTheme.customFont) { setCustomFontFamily(undefined); return; }
    const fontName = `CustomAdv_${world.id.slice(0, 8)}`;
    let cancelled = false;
    const face = new FontFace(fontName, `url("${worldTheme.customFont}")`);
    face.load().then(loaded => {
      if (cancelled) return;
      document.fonts.add(loaded);
      setCustomFontFamily(`'${fontName}', 'PingFang SC', system-ui, sans-serif`);
    }).catch(err => {
      console.warn("Custom font load failed:", err);
      if (!cancelled) setCustomFontFamily(undefined);
    });
    return () => { cancelled = true; try { document.fonts.delete(face); } catch { } };
  }, [worldTheme.customFont, world.id]);

  // Persist immediately on every stream change
  React.useEffect(() => {
    if (streamMessages.length === 0) return;
    persistSave(saveRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamMessages]);

  // Connect debug callback
  React.useEffect(() => {
    setDMDebugCallback((type, content) => {
      const time = new Date().toLocaleTimeString();
      setDebugLog(prev => [...prev.slice(-50), { time, type, content }]);
    });
    return () => setDMDebugCallback(null);
  }, []);

  const { renderedMap, skeleton } = world;
  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(() => {
    if (save.agents.length === 1) {
      // Single agent: use that character's binding
      return resolveUserIdentity(save.agents[0].characterId, "adventure");
    }
    // Multiple agents or no agents: use global default
    return resolveUserIdentity(undefined, "adventure");
  }, [save.agents]);
  const charName = useCallback((id: string) => characters.find(c => c.id === id)?.name || id, [characters]);

  const avatarMap = useMemo(() => {
    const map: Record<string, string> = {};
    // Player avatar
    const playerName = userIdentity?.name || "你";
    if (userIdentity?.avatarUrl) map[playerName] = userIdentity.avatarUrl;
    // Companion avatars
    for (const a of save.agents) {
      const ch = characters.find(c => c.id === a.characterId);
      if (ch?.avatar) map[ch.name] = ch.avatar;
    }
    return map;
  }, [userIdentity, save.agents, characters]);
  const bilingualTranslationEnabled = adventureConfig.bilingualTranslationEnabled === true;
  const defaultTranslationExpanded = adventureConfig.collapseBilingualTranslation !== true;

  const agentsAtNode = useCallback((nodeId: string) =>
    save.agents.filter(a => a.characterId && a.currentNodeId === nodeId),
    [save.agents]);

  // Build a lookup of all nodes
  const allNodes = useMemo(() => {
    const nodes: { id: string; x: number; y: number; name: string; type: "l1" | "l2" | "l3"; regionIdx: number }[] = [];
    renderedMap.l1Nodes.forEach((n, i) => nodes.push({ id: n.id, x: n.x, y: n.y, name: n.nameCn, type: "l1", regionIdx: i }));
    renderedMap.l2Nodes.forEach((n, i) => nodes.push({ id: `l2_${i}`, x: n.x, y: n.y, name: n.name, type: "l2", regionIdx: n.regionIdx }));
    renderedMap.l3Nodes.forEach((n, i) => nodes.push({ id: `l3_${i}`, x: n.x, y: n.y, name: n.name, type: "l3", regionIdx: n.regionIdx }));
    return nodes;
  }, [renderedMap]);

  const nodeMap = useMemo(() => new Map(allNodes.map(n => [n.id, n])), [allNodes]);
  const currentNode = nodeMap.get(save.currentNodeId);
  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : null;

  const discoveredRegions = useMemo(() => {
    const regions = new Set<number>();
    for (const nodeId of save.discoveredNodes) {
      const node = allNodes.find(n => n.id === nodeId);
      if (node) regions.add(node.regionIdx);
    }
    return regions;
  }, [save.discoveredNodes, allNodes]);

  const isVisible = useCallback((nodeId: string) => {
    if (save.discoveredNodes.includes(nodeId)) return true;
    const node = allNodes.find(n => n.id === nodeId);
    return node ? discoveredRegions.has(node.regionIdx) : false;
  }, [save.discoveredNodes, allNodes, discoveredRegions]);

  const isVisited = useCallback((nodeId: string) => {
    return save.visitedNodes.includes(nodeId);
  }, [save.visitedNodes]);



  // Nearby nodes for exploration action bar
  const nearbyNodes = useMemo(() => {
    if (!currentNode) return [];
    // Use edge graph: find all nodes directly connected by routes
    const connectedIds = new Set<string>();
    for (const [a, b] of renderedMap.edges || []) {
      if (a === save.currentNodeId) connectedIds.add(b);
      if (b === save.currentNodeId) connectedIds.add(a);
    }
    return allNodes
      .filter(n => connectedIds.has(n.id) && isVisible(n.id))
      .slice(0, 10);
  }, [allNodes, save.currentNodeId, currentNode, isVisible, renderedMap.edges]);

  // Get interactions available at current node
  const getInteractions = useCallback((nodeId: string): NodeInteraction[] => {
    const node = nodeMap.get(nodeId);
    if (!node || nodeId !== save.currentNodeId) return [];

    const interactions: NodeInteraction[] = [];

    const nodeName = node.name;
    const regionId = skeleton.mapInput.regions[node.regionIdx]?.id;

    // Main quest: match by node name
    const stage = skeleton.mainQuest.stages[save.mainQuestStage];
    if (stage) {
      if (stage.locationHint === nodeName || stage.locationHint.includes(nodeName) || nodeName.includes(stage.locationHint)) {
        interactions.push({ type: "quest", label: `主线：${skeleton.mainQuest.title}`, questId: skeleton.mainQuest.id, available: true, icon: "📋" });
      }
    }

    // Side quests: match by region (trigger region) or active
    const allCompleted = save.agents.flatMap(a => a.completedSideQuests);
    const allActive = save.agents.flatMap(a => a.activeSideQuests);
    for (const sq of skeleton.sideQuests) {
      if (allCompleted.includes(sq.id)) continue;
      if (allActive.includes(sq.id) || regionId === sq.triggerRegion) {
        interactions.push({ type: "sidequest", label: `支线：${sq.title}`, questId: sq.id, available: true, icon: "📋" });
      }
    }

    // NPCs: match by specific node name, fallback to region L1 name for L1 NPCs
    const nodeNpcs = skeleton.npcs.filter(n => {
      if (n.locationNode === nodeName) return true;
      // L1 NPC: show at the L1 node of that region
      if (!n.locationNode && n.locationRegion === regionId && node.type === "l1") return true;
      return false;
    });
    for (const npc of nodeNpcs) {
      interactions.push({ type: "talk", label: `和${npc.name}交谈`, available: true, icon: "💬" });
    }

    const searchCount = save.searchedNodes[nodeId] || 0;
    if (searchCount < 3) {
      interactions.push({ type: "search", label: "搜索周围", available: true, icon: "🔍" });
    }

    if (node.type === "l1") {
      interactions.push({ type: "rest", label: "休息", available: true, icon: "🏕" });
    } else {
      interactions.push({ type: "rest", label: "扎营", available: true, icon: "⛺" });
    }

    return interactions;
  }, [save, skeleton, nodeMap]);

  // Push scene dialogues to stream
  const pushSceneToStream = useCallback((scene: EventScene) => {
    const msgs: StreamMessage[] = scene.dialogues.map(d => ({
      id: mkId(),
      type: d.speaker === "narrator" ? "narration" as const : "npc" as const,
      speaker: d.speaker === "narrator" ? undefined : d.speaker,
      text: d.text,
      emotion: d.emotion,
    }));
    pushMessages(...msgs);
  }, [pushMessages]);

  // Initial location message
  const initialPushed = useRef(streamMessages.length > 0);
  React.useEffect(() => {
    if (currentNode && !initialPushed.current) {
      initialPushed.current = true;
      pushMessages({
        id: mkId(), type: "location",
        text: `你正在 ${currentNode.name}`,
      });
    }
  }, [currentNode, pushMessages]);

  // Handle move
  const handleMove = useCallback((targetNodeId: string) => {
    const target = nodeMap.get(targetNodeId);
    if (!target) return;

    const newDiscovered = [...save.discoveredNodes];
    for (const n of allNodes) {
      if (!newDiscovered.includes(n.id)) {
        if (n.regionIdx === target.regionIdx || n.type === "l1") {
          newDiscovered.push(n.id);
        }
      }
    }

    // All agents follow the player on manual move
    const movedAgents = save.agents.map(a => ({
      ...a,
      currentNodeId: targetNodeId,
      currentNodeType: target.type,
      discoveredNodes: [...new Set([...a.discoveredNodes, targetNodeId])],
    }));

    const newSave: GameSave = {
      ...save,
      currentNodeId: targetNodeId,
      currentNodeType: target.type,
      agents: movedAgents,
      discoveredNodes: newDiscovered,
      visitedNodes: save.visitedNodes.includes(targetNodeId) ? save.visitedNodes : [...save.visitedNodes, targetNodeId],
      timestamp: new Date().toISOString(),
    };

    persistSave(newSave);
    setSelectedNodeId(null);

    // Push location message to stream
    pushMessages({
      id: mkId(), type: "location",
      text: `你来到了 ${target.name}`,
    });
  }, [save, nodeMap, allNodes, persistSave, pushMessages]);

  // Handle rest
  const handleRest = useCallback(() => {
    const isCity = save.currentNodeType === "l1";
    const recoveredHp = isCity ? save.maxHp : Math.min(save.maxHp, save.hp + 30);
    const restText = isCity ? "在城中休息了一晚，恢复了全部生命值。" : "在野外扎营过夜，恢复了少许生命值。";
    const newSave: GameSave = {
      ...save,
      hp: recoveredHp,
      gameTime: "morning",
      gameDay: save.gameDay + 1,
      journal: [...save.journal, {
        id: `j_${Date.now()}`,
        timestamp: formatGameTime(save.gameDay + 1, "morning"),
        realTime: new Date().toISOString(),
        locationName: currentNode?.name || "",
        text: restText,
        type: "discovery",
      }],
      timestamp: new Date().toISOString(),
    };
    persistSave(newSave);

    pushMessages({ id: mkId(), type: "system", text: restText });
  }, [save, currentNode, persistSave, pushMessages]);

  // ── Trigger an event (calls LLM → pushes to stream) ──
  const triggerEvent = useCallback(async (
    eventType: "main_quest" | "side_quest" | "encounter" | "search" | "talk",
    brief: string,
    meta?: { questId?: string; npcName?: string; npcPersonality?: string },
  ) => {
    if (inEvent || eventLoading) return;
    setEventLoading(true);
    setActiveEventMeta({ type: eventType, questId: meta?.questId });
    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      // DM API: multi-agent → global binding; single-agent → that agent's adventure binding
      const dmSlot = save.agents.length === 1
        ? resolveBinding(bindings, save.agents[0].characterId, "adventure")
        : resolveBinding(bindings, undefined, "adventure");
      const apiConfig = (dmSlot?.apiConfigId ? apiConfigs.find(c => c.id === dmSlot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("未找到有效的API配置，请先在设置中配置API");

      const companionIds = save.agents
        .filter(a => a.currentNodeId === save.currentNodeId)
        .map(a => a.characterId);
      const companionNames = companionIds.map(id => charName(id));

      const stagesWithResults = skeleton.mainQuest.stages.map((s, i) => ({
        brief: s.brief,
        result: save.director.mainArc.stageResults.find(r => r.stage === i)?.outcome,
      }));

      const npcSecret = meta?.npcName
        ? skeleton.dmDossier?.npcSecrets[skeleton.npcs.find(n => n.name === meta.npcName)?.id || ""] || undefined
        : undefined;

      const allCompleted = save.agents.flatMap(a => a.completedSideQuests);
      const sqStatus: Record<string, string> = {};
      for (const sq of skeleton.sideQuests) {
        sqStatus[sq.id] = allCompleted.includes(sq.id) ? "已完成" : "未触发";
      }
      const mqNodeMap: Record<number, string> = {};
      skeleton.mainQuest.stages.forEach((s, i) => { mqNodeMap[i] = s.locationHint; });

      const dmCtx = {
        worldLore: skeleton.world.lore,
        currentLocation: currentNode?.name || "",
        eventType,
        eventBrief: brief,
        npcName: meta?.npcName,
        npcPersonality: meta?.npcPersonality,
        npcSecret,
        companionNames,
        playerName: userIdentity?.name || "玩家",
        recentJournal: save.journal.map(j => j.text),
        keyChoices: save.keyChoices,
        gameTime: formatGameTime(save.gameDay, save.gameTime),
        dmDossier: skeleton.dmDossier,
        director: save.director,
        mainQuestSynopsis: skeleton.mainQuest.synopsis,
        mainQuestStages: stagesWithResults,
        richRegions: skeleton.richRegions,
        sideQuestStatus: sqStatus,
        mainQuestNodeMap: mqNodeMap,
        partyStatus: {
          hp: save.hp,
          maxHp: save.maxHp,
          items: save.director.keyItems,
          playerStats: save.playerStats,
          companions: save.agents
            .filter(a => a.currentNodeId === save.currentNodeId)
            .map(a => {
              const ch = characters.find(c => c.id === a.characterId);
              return { name: ch?.name || a.characterId, affinity: a.affinity, stats: a.stats, status: "" };
            }),
        },
        pacing: save.pacing,
      };

      const scene = await expandEvent(dmCtx, companionIds, apiConfig);
      const dmScene = scene as EventScene & { dmSituation?: string; worldEvents?: string[] };
      if (dmScene.worldEvents?.length) setWorldEvents(dmScene.worldEvents);

      const sceneJournal = scene.journalEntry?.trim();
      if (sceneJournal) {
        persistSave({
          ...save,
          journal: [...save.journal, {
            id: `j_${Date.now()}`,
            timestamp: formatGameTime(save.gameDay, save.gameTime),
            realTime: new Date().toISOString(),
            locationName: currentNode?.name || "",
            text: sceneJournal,
            type: eventType === "main_quest" ? "main" : "side",
          }],
          timestamp: new Date().toISOString(),
        });
      }

      // Push dialogues to text stream
      pushSceneToStream(scene);

      // Set event state for continuation
      setActiveEvent(scene);
      setAccumulatedEvent(scene);
      setEventContext(JSON.stringify(dmCtx));
      setInEvent(true);

      // Set choices if available
      if (scene.choices && scene.choices.length > 0) {
        setCurrentChoices(scene.choices);
        setTimeout(() => inputRef.current?.focus(), 200);
      } else {
        // No choices — event done immediately
        setCurrentChoices(null);
        setInEvent(false);
        setActiveEvent(null);
        setActiveEventMeta(null);
        pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
      }
      setLastFailedEvent(null); // success — clear any previous failure
    } catch (e) {
      console.warn("[MapView] Event trigger error:", e);
      pushMessages({ id: mkId(), type: "system", text: `事件触发失败：${e instanceof Error ? e.message : String(e)}` });
      setLastFailedEvent({ type: eventType, brief, meta });
      setActiveEvent(null);
      setActiveEventMeta(null);
      setInEvent(false);
    } finally {
      setEventLoading(false);
    }
  }, [save, skeleton, currentNode, characters, inEvent, eventLoading, pushSceneToStream, pushMessages]);

  // ── Handle player action — Collect-Resolve-Narrate loop ──
  const handlePlayerAction = useCallback(async (actionText: string, skipDisplay?: boolean) => {
    // ── Phase 2: Player declares ──
    const playerName = userIdentity?.name || "你";
    if (!skipDisplay) {
      // Parse "说：「xxx」\n做：xxx" format for display — sync streamRef so companions see it
      const sayMatch = actionText.match(/说：「(.+?)」/);
      const doMatch = actionText.match(/做：(.+)/);
      if (sayMatch) {
        const msg: StreamMessage = { id: mkId(), type: "player", speaker: playerName, text: sayMatch[1] };
        pushMessages(msg);
        streamRef.current = [...streamRef.current, msg];
      }
      if (doMatch) {
        const msg: StreamMessage = { id: mkId(), type: "narration", text: `${playerName}${doMatch[1]}` };
        pushMessages(msg);
        streamRef.current = [...streamRef.current, msg];
      }
      if (!sayMatch && !doMatch) {
        const msg: StreamMessage = { id: mkId(), type: "narration", text: `${playerName}：${actionText}` };
        pushMessages(msg);
        streamRef.current = [...streamRef.current, msg];
      }
    }
    setCurrentChoices(null);
    setEventContinueLoading(true);
    setLastFailedAction(actionText);  // save immediately so it persists if interrupted

    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      // DM API: multi-agent → global binding; single-agent → that agent's adventure binding
      const dmSlot = save.agents.length === 1
        ? resolveBinding(bindings, save.agents[0].characterId, "adventure")
        : resolveBinding(bindings, undefined, "adventure");
      const apiConfig = (dmSlot?.apiConfigId ? apiConfigs.find(c => c.id === dmSlot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("未找到有效的API配置");

      // ── Phase 3: Companions declare — detect already-replied from stream ──
      const companionIds = save.agents.map(a => a.characterId);

      // Include full stream log (narration + NPC + player + character + rolls) so DM sees free-chat context too
      const prevDialogue = streamRef.current
        .filter(m => m.type !== "system")
        .map(m => m.speaker ? `${m.speaker}: ${m.text}` : m.text)
        .join("\n");


      const companionDecls: Declaration[] = [];
      if (companionIds.length > 0) {
        // Check which companions already completed (persisted in pendingEvent.completedCompanions)
        const alreadyDone = new Set(completedCompanionsRef.current);

        const pendingIds = companionIds.filter(cid => !alreadyDone.has(cid));

        if (pendingIds.length > 0) {
          setLoadingPhase("companions");
          for (const cid of pendingIds) {
            const decl = await companionDeclare(cid, apiConfig, streamRef.current, save.agents.length > 1 ? userIdentity : undefined, save.agents.find(a => a.characterId === cid)?.affinity);

            if (decl.failed) {
              pushMessages({ id: mkId(), type: "system", text: `${decl.speaker} 回复失败` });
              throw new Error(`${decl.speaker}回复失败，请重试`);
            }

            // Mark as completed and persist immediately
            completedCompanionsRef.current = [...completedCompanionsRef.current, cid];
            setCompletedCompanions(completedCompanionsRef.current);

            companionDecls.push(decl);
            if (decl.speech && decl.speech !== "……") {
              const msg: StreamMessage = { id: mkId(), type: "character", speaker: decl.speaker, text: decl.speech, emotion: decl.emotion };
              pushMessages(msg);
              streamRef.current = [...streamRef.current, msg];
            }
            if (decl.action && decl.action !== "跟随队伍" && decl.action !== "沉默不动") {
              const msg: StreamMessage = { id: mkId(), type: "narration", text: `${decl.speaker}：${decl.action}` };
              pushMessages(msg);
              streamRef.current = [...streamRef.current, msg];
            }
          }
        }
      }

      // ── Phase 3.5: Apply affinity changes from companion declarations ──
      for (const decl of companionDecls) {
        if (decl.affinityDelta && decl.affinityDelta !== 0) {
          const agentIdx = save.agents.findIndex(a => {
            const ch = characters.find(c => c.id === a.characterId);
            return ch?.name === decl.speaker;
          });
          if (agentIdx >= 0) {
            save = {
              ...save,
              agents: save.agents.map((a, i) =>
                i === agentIdx ? { ...a, affinity: Math.max(0, Math.min(100, a.affinity + decl.affinityDelta!)) } : a
              ),
            };
            persistSave(save);
          }
        }
      }

      // ── Phase 4: DM resolves all declarations ──
      setLoadingPhase("dm");
      const allDeclarations: Declaration[] = [
        { speaker: playerName, speech: actionText, action: actionText },
        ...companionDecls,
      ];

      let dmCtx: import("@/lib/map-rpg-engine").DMContext;
      try { dmCtx = JSON.parse(eventContext); } catch { dmCtx = { worldLore: "", currentLocation: "", eventType: "", eventBrief: "", companionNames: [], recentJournal: [], keyChoices: [], gameTime: "" }; }
      dmCtx.previousDialogue = prevDialogue;
      dmCtx.director = save.director;
      dmCtx.recentJournal = saveRef.current.journal.map(j => j.text);

      const continuation = await resolveRound(dmCtx, allDeclarations, apiConfig);

      // Update Director
      const ev = continuation as EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; moveTo?: string; worldEvents?: string[] };
      if (ev.worldEvents?.length) setWorldEvents(ev.worldEvents);
      const updatedDirector = { ...save.director };

      if (continuation.advanceMainQuest && activeEventMeta?.type === "main_quest") {
        updatedDirector.mainArc = {
          ...updatedDirector.mainArc,
          currentStage: updatedDirector.mainArc.currentStage + 1,
          stageResults: [...updatedDirector.mainArc.stageResults, {
            stage: updatedDirector.mainArc.currentStage,
            outcome: continuation.journalEntry || actionText,
            itemsGained: ev.gained || [],
            npcsInvolved: ev.npcsInvolved || [],
          }],
        };
      }

      // Process gained/lost — detect stat bonuses
      // Parse stat growth: "力量+5" or "小雪:感知+5" — supports all 7 stats
      // Parse gained (items only, no stat growth — growth is automatic)
      const newPlayerStats = { ...save.playerStats };
      let updatedAgents = [...save.agents];
      if (ev.gained?.length) updatedDirector.keyItems = [...new Set([...updatedDirector.keyItems, ...ev.gained])];

      // Parse lost — HP, stat decreases, and items
      const statNameMap: Record<string, string> = { 力量: "str", 体质: "con", 敏捷: "dex", 智力: "int", 感知: "per", 魅力: "cha", 运气: "lck" };
      const lossPattern = /^(?:(.+?)[：:])?(.+?)(-\d+)$/;
      const lostItems: string[] = [];
      let hpChange = 0;
      for (const item of ev.lost || []) {
        const m = item.match(lossPattern);
        if (m && (m[2] === "HP" || m[2] === "hp")) {
          // HP loss: "HP-15" or "小雪:HP-10"
          const target = m[1] || "";
          const delta = parseInt(m[3] || "0");
          if (!target) {
            hpChange += delta;
          } else {
            updatedAgents = updatedAgents.map(a => {
              const ch = characters.find(c => c.id === a.characterId);
              if (ch?.name === target) return { ...a, hp: Math.max(0, a.hp + delta) };
              return a;
            });
          }
        } else if (m && statNameMap[m[2]]) {
          // Stat loss: "体质-5" or "小雪:力量-3"
          const target = m[1] || "";
          const stat = statNameMap[m[2]] as import("@/lib/map-types").StatKey;
          const delta = parseInt(m[3] || "0");
          if (!target) {
            (newPlayerStats as Record<string, number>)[stat] = Math.max(1, (newPlayerStats[stat] || 50) + delta);
            pushMessages({ id: mkId(), type: "system", text: `${STAT_LABELS[stat]} ${delta}` });
          } else {
            updatedAgents = updatedAgents.map(a => {
              const ch = characters.find(c => c.id === a.characterId);
              if (ch?.name === target) return { ...a, stats: { ...a.stats, [stat]: Math.max(1, (a.stats[stat] || 50) + delta) } };
              return a;
            });
          }
        } else {
          lostItems.push(item);
        }
      }
      // Apply HP change
      const newHp = hpChange ? Math.max(0, save.hp + hpChange) : save.hp;
      if (hpChange) pushMessages({ id: mkId(), type: "system", text: `HP ${hpChange}（${save.hp}→${newHp}）` });
      if (lostItems.length) updatedDirector.keyItems = updatedDirector.keyItems.filter(i => !lostItems.includes(i));
      if (ev.npcsInvolved?.length) updatedDirector.keyNpcsMet = [...new Set([...updatedDirector.keyNpcsMet, ...ev.npcsInvolved])];

      // Gained/lost system messages
      if (ev.gained?.length) pushMessages({ id: mkId(), type: "system", text: `获得：${ev.gained.join("、")}` });
      if (lostItems.length) pushMessages({ id: mkId(), type: "system", text: `失去：${lostItems.join("、")}` });

      const newJournal = [...saveRef.current.journal];
      if (ev.journalEntry) {
        newJournal.push({
          id: `j_${Date.now()}`, timestamp: formatGameTime(save.gameDay, save.gameTime),
          realTime: new Date().toISOString(), locationName: currentNode?.name || "",
          text: ev.journalEntry, type: activeEventMeta?.type === "main_quest" ? "main" : "side",
        });
      }

      // Handle position change from DM
      let newNodeId = save.currentNodeId;
      let newNodeType = save.currentNodeType;
      const newDiscovered = [...new Set([...save.discoveredNodes, ...(ev.unlocks || [])])];

      // Unified move_to handling: string = everyone moves; object = per-person
      const fuzzyNode = (name: string) =>
        allNodes.find(n => n.name === name)
        || allNodes.find(n => n.name.includes(name))
        || allNodes.find(n => name.includes(n.name));

      const discoverNode = (nodeId: string) => {
        if (!newDiscovered.includes(nodeId)) newDiscovered.push(nodeId);
        for (const n of allNodes) {
          if (n.regionIdx === allNodes.find(x => x.id === nodeId)?.regionIdx && !newDiscovered.includes(n.id)) {
            newDiscovered.push(n.id);
          }
        }
      };

      const moveAgent = (charName: string, destName: string) => {
        const destNode = fuzzyNode(destName);
        if (!destNode) return;
        updatedAgents = updatedAgents.map(a => {
          const ch = characters.find(c => c.id === a.characterId);
          if (ch?.name === charName) {
            return { ...a, currentNodeId: destNode.id, currentNodeType: destNode.type, discoveredNodes: [...new Set([...a.discoveredNodes, destNode.id])] };
          }
          return a;
        });
        discoverNode(destNode.id);
      };

      const rawMoveTo = ev.moveTo;
      if (rawMoveTo && typeof rawMoveTo === "string") {
        // String: everyone moves to the same place
        const targetNode = fuzzyNode(rawMoveTo);
        if (targetNode) {
          newNodeId = targetNode.id;
          newNodeType = targetNode.type;
          discoverNode(targetNode.id);
          pushMessages({ id: mkId(), type: "location", text: `你来到了 ${targetNode.name}` });
          // All agents follow
          for (const a of updatedAgents) {
            const ch = characters.find(c => c.id === a.characterId);
            if (ch) moveAgent(ch.name, rawMoveTo);
          }
        }
      } else if (rawMoveTo && typeof rawMoveTo === "object") {
        // Object: per-person moves
        for (const [who, destName] of Object.entries(rawMoveTo as Record<string, string>)) {
          if (who === "你" || who === (userIdentity?.name || "玩家")) {
            // Player
            const targetNode = fuzzyNode(destName);
            if (targetNode) {
              newNodeId = targetNode.id;
              newNodeType = targetNode.type;
              discoverNode(targetNode.id);
              pushMessages({ id: mkId(), type: "location", text: `你来到了 ${targetNode.name}` });
            }
          } else {
            // Agent
            moveAgent(who, destName);
          }
        }
      }

      const newSave: GameSave = {
        ...save,
        currentNodeId: newNodeId,
        currentNodeType: newNodeType,
        hp: newHp,
        playerStats: newPlayerStats,
        agents: updatedAgents,
        director: updatedDirector,
        journal: newJournal,
        keyChoices: actionText ? [...save.keyChoices, actionText] : save.keyChoices,
        mainQuestStage: ev.advanceMainQuest ? Math.min(save.mainQuestStage + 1, skeleton.mainQuest.stages.length) : save.mainQuestStage,
        discoveredNodes: newDiscovered,
        visitedNodes: newNodeId !== save.currentNodeId ? [...new Set([...save.visitedNodes, newNodeId])] : save.visitedNodes,
        timestamp: new Date().toISOString(),
      };
      persistSave(newSave);

      // ── Death check: HP=0 → show death dialog ──
      if (newHp <= 0) {
        pushMessages({ id: mkId(), type: "system", text: "你倒下了..." });
        setShowDeathDialog(true);
        setInEvent(false);
        setCurrentChoices(null);
        setActiveEvent(null);
        setActiveEventMeta(null);
        setAccumulatedEvent(null);
        return;
      }

      // ── Ending check: DM decides ending ──
      if ((continuation as { ending?: boolean }).ending) {
        pushMessages({ id: mkId(), type: "system", text: "—— 主线完成 ——" });
        pushSceneToStream(continuation);
        persistSave({ ...newSave, completed: true });
        setInEvent(false);
        setCurrentChoices(null);
        setActiveEvent(null);
        setActiveEventMeta(null);
        setAccumulatedEvent(null);
        // Generate ending (async)
        try {
          let dmCtxForEnding: import("@/lib/map-rpg-engine").DMContext;
          try { dmCtxForEnding = JSON.parse(eventContext); } catch { dmCtxForEnding = { worldLore: skeleton.world.lore, currentLocation: currentNode?.name || "", eventType: "", eventBrief: "", companionNames: [], recentJournal: save.journal.map(j => j.text), keyChoices: save.keyChoices, gameTime: formatGameTime(save.gameDay, save.gameTime) }; }
          dmCtxForEnding.director = newSave.director;
          dmCtxForEnding.recentJournal = newSave.journal.map(j => j.text);
          const ending = await generateEnding(dmCtxForEnding, apiConfig);
          setEndingData(ending);
          setEndingStep(0);
          // Final summary on game completion — use auxiliary API
          const endSummaryApi = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || apiConfig;
          generateAdventureSummary(newSave, skeleton.world.name, endSummaryApi).catch(() => undefined);
        } catch (e) {
          pushMessages({ id: mkId(), type: "system", text: `结局生成失败：${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }

      // Push DM continuation to stream
      if (continuation.dialogues.length > 0) {
        pushSceneToStream(continuation);
        setActiveEvent(continuation);
        // Include companion declarations in accumulated dialogue for next round context
        const declDialogues = companionDecls.map(d => ({ speaker: d.speaker, text: `${d.speech}（${d.action}）`, emotion: d.emotion }));
        setAccumulatedEvent(prev => prev ? {
          ...prev,
          dialogues: [...prev.dialogues, { speaker: playerName, text: actionText, emotion: "neutral" }, ...declDialogues, ...continuation.dialogues],
          choices: continuation.choices,
        } : continuation);
        setEventContext(JSON.stringify(dmCtx));

        if (continuation.choices && continuation.choices.length > 0) {
          setCurrentChoices(continuation.choices);
          setLastFailedAction(null); setCompletedCompanions([]); // success — clear pending action
          setTimeout(() => inputRef.current?.focus(), 200);
        } else {
          // Event finished — run growth roll
          setLastFailedAction(null);          pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
          const grownSave = runGrowthRollRef.current(newSave);
          if (grownSave !== newSave) persistSave(grownSave);
          setCurrentChoices(null);
          setInEvent(false);
          setActiveEvent(null);
          setActiveEventMeta(null);
          setAccumulatedEvent(null);
        }
      } else {
        // Event finished — run growth roll
        pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
        const grownSave = runGrowthRoll(newSave);
        if (grownSave !== newSave) persistSave(grownSave);
        setCurrentChoices(null);
        setInEvent(false);
        setActiveEvent(null);
        setActiveEventMeta(null);
        setAccumulatedEvent(null);
      }
    } catch (e) {
      console.warn("[MapView] Event action error:", e);
      pushMessages({ id: mkId(), type: "system", text: `发生错误：${e instanceof Error ? e.message : String(e)}` });
      setLastFailedAction(actionText);
    } finally {
      setEventContinueLoading(false);
      setLoadingPhase("");
      // Auto-summary check (fire-and-forget)
      const latestSave = saveRef.current;
      if (shouldAutoSummarize(latestSave)) {
        const summaryApi = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || loadApiConfigs().find(c => c.apiKey);
        if (summaryApi?.apiKey) {
          generateAdventureSummary(latestSave, skeleton.world.name, summaryApi).catch(() => undefined);
        }
      }
    }
  }, [eventContext, accumulatedEvent, save, currentNode, activeEventMeta, persistSave, allNodes, characters, pushMessages, pushSceneToStream, userIdentity, skeleton]);

  // ── Growth roll ref (defined below, used by handlePlayerAction) ──
  const runGrowthRollRef = useRef<(s: GameSave) => GameSave>((s) => s);

  // ── Growth roll — called when event ends, for each checked stat ──
  const runGrowthRoll = useCallback((currentSave: GameSave): GameSave => {
    const checked = currentSave.checkedStats || [];
    if (checked.length === 0) return currentSave;

    const newStats = { ...currentSave.playerStats };
    const growthMessages: string[] = [];

    for (const stat of checked) {
      const current = newStats[stat] || 50;
      const roll = Math.floor(Math.random() * 100) + 1;
      if (roll > current) {
        // Growth! +1d10
        const gain = Math.floor(Math.random() * 10) + 1;
        const newVal = Math.min(99, current + gain);
        (newStats as Record<string, number>)[stat] = newVal;
        growthMessages.push(`${STAT_LABELS[stat]} ${current}→${newVal} (+${gain})`);
      }
    }

    if (growthMessages.length > 0) {
      pushMessages({
        id: mkId(), type: "system",
        text: `📈 属性成长：${growthMessages.join("、")}`,
      });
    } else if (checked.length > 0) {
      pushMessages({
        id: mkId(), type: "system",
        text: `属性成长 roll 失败，本次无成长`,
      });
    }

    return { ...currentSave, playerStats: newStats, checkedStats: [] };
  }, [pushMessages]);
  runGrowthRollRef.current = runGrowthRoll;

  // ── Handle event exit — send as player action so DM knows ──
  const handleEventExit = useCallback(async () => {
    const playerName = userIdentity?.name || "你";
    const exitMsg: StreamMessage = { id: mkId(), type: "narration", text: `${playerName}：决定离开，不再继续当前事件。` };
    pushMessages(exitMsg);
    streamRef.current = [...streamRef.current, exitMsg];
    setCurrentChoices(null);

    // Let companions react to the exit decision
    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      const firstCharId = save.agents[0]?.characterId || characters[0]?.id || "";
      const slot = firstCharId ? resolveBinding(bindings, firstCharId, "adventure") : null;
      const apiConfig = (slot?.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];

      if (apiConfig?.apiKey) {
        const companionIds = save.agents.map(a => a.characterId);
        if (companionIds.length > 0) {
          setEventContinueLoading(true);
          setLoadingPhase("companions");
          const exitReactionInstruction = "{{user}}刚才决定离开当前事件，不再继续。请以你的身份回应{{user}}的离开：你会说什么、有什么反应、接下来是否跟随/挽留/沉默旁观。";
          const decls = await Promise.all(
            companionIds.map(cid => companionDeclare(
              cid,
              apiConfig,
              streamRef.current,
              save.agents.length > 1 ? userIdentity : undefined,
              save.agents.find(a => a.characterId === cid)?.affinity,
              { instruction: exitReactionInstruction },
            ))
          );
          for (const decl of decls) {
            if (decl.speech && decl.speech !== "……") {
              pushMessages({ id: mkId(), type: "character", speaker: decl.speaker, text: decl.speech, emotion: decl.emotion });
            }
          }
          setEventContinueLoading(false);
          setLoadingPhase("");
        }
      }
    } catch { /* ignore errors on exit */ }

    // Exit event
    pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
    setInEvent(false);
    setActiveEvent(null);
    setActiveEventMeta(null);
    setAccumulatedEvent(null);
    setLastFailedAction(null);  }, [save, characters, userIdentity, pushMessages]);

  // ── Handle choice click — if statCheck, everyone rolls, then proceed ──
  const handleChoiceClick = useCallback(async (choice: EventChoice) => {
    if (!choice.statCheck) {
      handlePlayerAction(choice.label);
      return;
    }

    const statKey = choice.statCheck.stat;
    const label = STAT_LABELS[statKey] || statKey;
    const rollResults: string[] = [];

    // Helper: run dice overlay for one person
    const rollFor = async (name: string, statValue: number, isPlayer: boolean): Promise<{ roll: number; level: string }> => {
      setDiceOverlay({ name, stat: statKey, statValue, context: choice.label, label, isPlayer });
      setDiceNumber(0);
      setDiceRolling(false);

      if (isPlayer) {
        setDiceWaitingClick(true);
        await new Promise<void>(resolve => {
          diceResolveRef.current = (() => { setDiceWaitingClick(false); resolve(); }) as unknown as (r: { roll: number; level: string }) => void;
        });
      } else {
        await new Promise<void>(resolve => setTimeout(resolve, 800));
      }

      setDiceRolling(true);
      return new Promise<{ roll: number; level: string }>(resolve => {
        const interval = setInterval(() => setDiceNumber(Math.floor(Math.random() * 100) + 1), 80);
        setTimeout(() => {
          clearInterval(interval);
          const r = rollD100(statValue);
          setDiceNumber(r.roll);
          setDiceRolling(false);
          setTimeout(() => { setDiceOverlay(null); setDiceNumber(0); resolve(r); }, 1200);
        }, 1000);
      });
    };

    // Determine who rolls
    const playerName = userIdentity?.name || "你";
    const candidates: { name: string; statValue: number; isPlayer: boolean }[] = [
      { name: playerName, statValue: save.playerStats[statKey] || 50, isPlayer: true },
    ];
    for (const a of save.agents) {
      const ch = characters.find(c => c.id === a.characterId);
      if (ch) candidates.push({ name: ch.name, statValue: a.stats[statKey] || 50, isPlayer: false });
    }

    let chosen: typeof candidates[0];
    const specifiedWho = choice.statCheck!.who;

    if (specifiedWho) {
      // DM specified who rolls
      chosen = candidates.find(c =>
        specifiedWho === "你" ? c.isPlayer : c.name === specifiedWho
      ) || candidates[0];
      const pickerMsg: StreamMessage = { id: mkId(), type: "system", text: `🎲 ${chosen.name} 掷骰` };
      pushMessages(pickerMsg);
      streamRef.current = [...streamRef.current, pickerMsg];
    } else if (candidates.length === 1) {
      // Only one person, no need to pick
      chosen = candidates[0];
    } else {
      // Random pick with animated picker
      chosen = candidates[Math.floor(Math.random() * candidates.length)];
      const names = candidates.map(c => c.name);
      await new Promise<void>(resolve => {
        let idx = 0;
        setPickerOverlay({ candidates: names, current: names[0], chosen: chosen.name, settled: false });
        const interval = setInterval(() => {
          idx = (idx + 1) % names.length;
          setPickerOverlay(prev => prev ? { ...prev, current: names[idx] } : null);
        }, 120);
        setTimeout(() => {
          clearInterval(interval);
          setPickerOverlay(prev => prev ? { ...prev, current: chosen.name, settled: true } : null);
          const rpMsg: StreamMessage = { id: mkId(), type: "system", text: `🎲 本轮由 ${chosen.name} 掷骰` };
          pushMessages(rpMsg);
          streamRef.current = [...streamRef.current, rpMsg];
          setTimeout(() => { setPickerOverlay(null); resolve(); }, 1000);
        }, 1200);
      });
    }

    // Roll
    const result = await rollFor(chosen.name, chosen.statValue, chosen.isPlayer);
    const success = result.level !== "fail" && result.level !== "fumble";
    const levelLabel = result.level === "crit" ? "大成功！" : result.level === "hard" ? "困难成功" : result.level === "success" ? "成功" : result.level === "fumble" ? "大失败！" : "失败";
    const rollMsg: StreamMessage = { id: mkId(), type: "roll", speaker: `${chosen.name} · ${choice.label}（${label} ${chosen.statValue}）`, text: `D100 = ${result.roll} → ${levelLabel}`, emotion: success ? "success" : "fail" };
    pushMessages(rollMsg);
    // Manually sync ref so companionDeclare sees the roll result (pushMessages is async setState)
    streamRef.current = [...streamRef.current, rollMsg];
    rollResults.push(`${chosen.name}掷骰：D100=${result.roll}（${label}${chosen.statValue}）→${levelLabel}`);

    // Proceed — skip display since roll messages already shown
    handlePlayerAction(choice.label, true);
  }, [handlePlayerAction, save, characters, userIdentity, pushMessages]);

  // ── Handle free text input ──
  const handleFreeInput = useCallback(() => {
    if ((!freeText.trim() && !freeAction.trim()) || eventContinueLoading || eventLoading) return;
    const speech = freeText.trim();
    const action = freeAction.trim();
    setFreeText("");
    setFreeAction("");
    // Combine: "说：xxx｜做：xxx" or just one
    // Always use prefix format so handlePlayerAction can parse correctly
    const combined = speech && action
      ? `说：「${speech}」\n做：${action}`
      : speech
        ? `说：「${speech}」`
        : `做：${action}`;
    if (inEvent) {
      handlePlayerAction(combined);
    } else {
      triggerEvent("talk", combined);
    }
  }, [freeText, freeAction, eventContinueLoading, eventLoading, inEvent, handlePlayerAction, triggerEvent]);

  const submitFreeInput = useCallback(() => {
    if (freeMode) {
      // Free mode: just push player message to stream, don't trigger DM
      const speech = freeText.trim();
      const action = freeAction.trim();
      if (!speech && !action) return;
      const playerName = userIdentity?.name || "你";
      if (speech) pushMessages({ id: mkId(), type: "player", speaker: playerName, text: speech });
      if (action) pushMessages({ id: mkId(), type: "narration", text: `${playerName}：${action}` });
      setFreeText("");
      setFreeAction("");
    } else {
      handleFreeInput();
    }
  }, [freeMode, freeText, freeAction, userIdentity, pushMessages, handleFreeInput]);

  const handleToggleFreeMode = useCallback(() => {
    if (freeMode) {
      setFreeMode(false);
      pushMessages({ id: mkId(), type: "system", text: "—— 自由交流结束 ——" });
    } else {
      setFreeMode(true);
      pushMessages({ id: mkId(), type: "system", text: "—— 自由交流模式 ——" });
    }
    setShowEventActionDrawer(false);
  }, [freeMode, pushMessages]);

  // ── Free mode: send message to a specific companion ──
  const handleFreeModeChat = useCallback(async (characterId: string) => {
    if (freeModeReplying) return;

    setFreeModeReplying(true);
    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      const slot = resolveBinding(bindings, characterId, "adventure");
      const apiConfig = (slot?.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("未找到API配置");

      const decl = await companionDeclare(characterId, apiConfig, streamRef.current, save.agents.length > 1 ? userIdentity : undefined, save.agents.find(a => a.characterId === characterId)?.affinity);

      if (decl.speech && decl.speech !== "……") {
        pushMessages({ id: mkId(), type: "character", speaker: decl.speaker, text: decl.speech, emotion: decl.emotion });
      }
      if (decl.action && decl.action !== "跟随队伍" && decl.action !== "沉默不动") {
        pushMessages({ id: mkId(), type: "narration", text: `${decl.speaker}：${decl.action}` });
      }
    } catch (e) {
      pushMessages({ id: mkId(), type: "system", text: `回复失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setFreeModeReplying(false);
    }
  }, [freeModeReplying, pushMessages]);

  // ── Direct DM resolve (skip companion LLM, use free-mode chat as declarations) ──
  const handleDirectResolve = useCallback(async () => {
    if (!inEvent || eventContinueLoading) return;
    setEventContinueLoading(true);
    setFreeMode(false);
    pushMessages({ id: mkId(), type: "system", text: "—— DM 裁决中 ——" });

    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      const dmSlot = save.agents.length === 1
        ? resolveBinding(bindings, save.agents[0].characterId, "adventure")
        : resolveBinding(bindings, undefined, "adventure");
      const apiConfig = (dmSlot?.apiConfigId ? apiConfigs.find(c => c.id === dmSlot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("未找到有效的API配置");

      const playerName = userIdentity?.name || "你";

      // Build declarations from recent stream (free-mode chat)
      const recentStream = streamRef.current;
      const playerMsgs = recentStream.filter(m => m.type === "player");
      const lastPlayerMsg = playerMsgs[playerMsgs.length - 1];
      const playerDecl: Declaration = {
        speaker: playerName,
        speech: lastPlayerMsg?.text || "",
        action: lastPlayerMsg?.text || "（基于之前的讨论行动）",
      };

      const companionDecls: Declaration[] = [];
      for (const a of save.agents) {
        const ch = characters.find(c => c.id === a.characterId);
        if (!ch) continue;
        const charMsgs = recentStream.filter(m => m.type === "character" && m.speaker === ch.name);
        const lastMsg = charMsgs[charMsgs.length - 1];
        companionDecls.push({
          speaker: ch.name,
          speech: lastMsg?.text || "",
          action: lastMsg?.text || "跟随队伍",
        });
      }

      const allDeclarations: Declaration[] = [playerDecl, ...companionDecls];

      // Build DM context
      const prevDialogue = recentStream
        .filter(m => m.type !== "system")
        .map(m => m.speaker ? `${m.speaker}: ${m.text}` : m.text)
        .join("\n");

      let dmCtx: import("@/lib/map-rpg-engine").DMContext;
      try { dmCtx = JSON.parse(eventContext); } catch { dmCtx = { worldLore: "", currentLocation: "", eventType: "", eventBrief: "", companionNames: [], recentJournal: [], keyChoices: [], gameTime: "" }; }
      dmCtx.previousDialogue = prevDialogue;
      dmCtx.director = save.director;
      dmCtx.recentJournal = save.journal.map(j => j.text);

      setLoadingPhase("dm");
      const continuation = await resolveRound(dmCtx, allDeclarations, apiConfig);

      // Reuse the same result processing as handlePlayerAction
      // (This duplicates some logic but keeps it self-contained)
      const ev = continuation as EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; moveTo?: string | Record<string, string>; worldEvents?: string[] };
      if (ev.worldEvents?.length) setWorldEvents(ev.worldEvents);

      if (continuation.dialogues.length > 0) {
        pushSceneToStream(continuation);
        setActiveEvent(continuation);
        setAccumulatedEvent(prev => prev ? {
          ...prev,
          dialogues: [...prev.dialogues, ...allDeclarations.map(d => ({ speaker: d.speaker, text: `${d.speech}（${d.action}）`, emotion: "neutral" })), ...continuation.dialogues],
          choices: continuation.choices,
        } : continuation);
        setEventContext(JSON.stringify(dmCtx));

        if (continuation.choices && continuation.choices.length > 0) {
          setCurrentChoices(continuation.choices);
          setLastFailedAction(null);          setTimeout(() => inputRef.current?.focus(), 200);
        } else {
          setLastFailedAction(null);          pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
          setCurrentChoices(null);
          setInEvent(false);
          setActiveEvent(null);
          setActiveEventMeta(null);
          setAccumulatedEvent(null);
        }
      } else {
        pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
        setCurrentChoices(null);
        setInEvent(false);
        setActiveEvent(null);
        setActiveEventMeta(null);
        setAccumulatedEvent(null);
      }

      // Save (simplified — skipping stat/item/position processing here, handled by handlePlayerAction for full events)
      persistSave({ ...save, timestamp: new Date().toISOString() });

    } catch (e) {
      pushMessages({ id: mkId(), type: "system", text: `裁决失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setEventContinueLoading(false);
      setLoadingPhase("");
    }
  }, [inEvent, eventContinueLoading, eventContext, save, characters, userIdentity, pushMessages, pushSceneToStream, persistSave]);

  // ── Handle interaction button click ──
  const handleInteraction = useCallback((ia: NodeInteraction) => {
    if (ia.type === "rest") {
      handleRest();
      return;
    }
    if (ia.type === "quest") {
      const stage = skeleton.mainQuest.stages[save.mainQuestStage];
      if (stage) triggerEvent("main_quest", `${skeleton.mainQuest.title}：${stage.brief}`);
      return;
    }
    if (ia.type === "sidequest") {
      const sq = skeleton.sideQuests.find(s => s.id === ia.questId);
      if (sq) triggerEvent("side_quest", `${sq.title}：${sq.synopsis}`, { questId: sq.id });
      return;
    }
    if (ia.type === "talk") {
      const npcName = ia.label.replace("和", "").replace("交谈", "");
      const npc = skeleton.npcs.find(n => ia.label.includes(n.name));
      triggerEvent("talk", `和${npc?.name || npcName}交谈`, { npcName: npc?.name, npcPersonality: npc?.personality });
      return;
    }
    if (ia.type === "search") {
      const newSearched = { ...save.searchedNodes, [save.currentNodeId]: (save.searchedNodes[save.currentNodeId] || 0) + 1 };
      const newSave = { ...save, searchedNodes: newSearched };
      persistSave(newSave);
      triggerEvent("search", `在${currentNode?.name}搜索周围`);
      return;
    }
  }, [save, skeleton, currentNode, handleRest, triggerEvent, persistSave]);

  // Handle save

  // ── Archive adventure ──
  const handleArchive = useCallback(() => {
    const summaryApi = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || loadApiConfigs().find(c => c.apiKey);
    if (summaryApi?.apiKey) {
      generateAdventureSummary(save, skeleton.world.name, summaryApi).catch(() => undefined);
    }
    persistSave({ ...save, timestamp: new Date().toISOString() });
    onBack();
  }, [save, skeleton, onBack]);

  // Trigger encounters after user moves
  const handleMoveWithAgents = useCallback((targetNodeId: string) => {
    if (inEvent || eventLoading) return;
    handleMove(targetNodeId);

    if (shouldTriggerEncounter(true)) {
      const node = nodeMap.get(targetNodeId);
      const regionIdx = node?.regionIdx ?? 0;
      const geography = skeleton.mapInput.regions[regionIdx]?.geography;
      const encounter = pickEncounter(skeleton.encounterPool, save.usedEncounterIds, geography);
      if (encounter) {
        const newSave = { ...save, usedEncounterIds: [...save.usedEncounterIds, encounter.id] };
        persistSave(newSave);
        setTimeout(() => triggerEvent("encounter", encounter.brief), 300);
      }
    }
  }, [handleMove, save, nodeMap, skeleton, triggerEvent, persistSave, inEvent, eventLoading]);

  // ── Current interactions ──
  const currentInteractions = useMemo(() => getInteractions(save.currentNodeId), [getInteractions, save.currentNodeId]);
  const canToggleFreeMode = !save.completed && save.agents.length > 0;
  const canExitCurrentEvent = !eventLoading && !eventContinueLoading && inEvent && !freeMode;
  const showEventActionHandle = canToggleFreeMode || canExitCurrentEvent;

  // ══════════════════════════════════════════════
  // ██ RENDER
  // ══════════════════════════════════════════════

  return (
    <div className="adventure-shell" data-adventure-theme={String(worldTheme.colorScheme || 0)} style={{
      position: "absolute", inset: 0,
      background: "var(--c-adv-bg)",
      display: "flex", flexDirection: "column",
      fontFamily: "'PingFang SC', system-ui, sans-serif",
      overflow: "hidden", color: "var(--c-adv-text)",
    }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "var(--page-header-safe-top, 48px)",
          background: "var(--c-adv-bar-bg)",
          zIndex: 0,
          pointerEvents: "none",
        }}
      />
      {/* ═══ Top Bar ═══ */}
      <div style={{
        height: "var(--page-header-content-height, 42px)",
        marginTop: "var(--page-header-safe-top, 48px)",
        padding: "1px 20px",
        background: "var(--c-adv-bar-bg)",
        backdropFilter: "none",
        borderBottom: "1px solid var(--c-adv-bar-border)",
        position: "relative", zIndex: 1,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexShrink: 0,
      }}>
        <button onClick={() => setShowArchiveConfirm(true)} style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: "var(--c-adv-text-dim)", cursor: "pointer" }}>
          <ArrowLeft size={20} />
        </button>

        <div style={{ textAlign: "center", flex: 1 }}>
          <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.1em", color: "var(--c-adv-text)" }}>
            {skeleton.world.name}
          </div>
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 2 }}>
            {formatGameTime(save.gameDay, save.gameTime)} · HP {save.hp}/{save.maxHp} · {currentNode?.name}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            aria-label="更多冒险操作"
            aria-expanded={showTopActionMenu}
            onClick={() => {
              const next = !showTopActionMenu;
              setShowTopActionMenu(next);
              if (next) setShowThemePanel(false);
            }}
            style={{
              width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none",
              color: showTopActionMenu ? "var(--c-adv-icon-active)" : "var(--c-adv-icon)",
              cursor: "pointer",
            }}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
      </div>

      {showTopActionMenu && (
        <>
          <div
            onClick={() => setShowTopActionMenu(false)}
            style={{ position: "absolute", inset: 0, zIndex: 46 }}
          />
          <div style={{
            position: "absolute",
            top: 104,
            right: 12,
            zIndex: 47,
            width: 148,
            padding: 7,
            borderRadius: 15,
            background: "var(--c-adv-panel-bg)",
            border: "1px solid var(--c-adv-input-border)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
            backdropFilter: "blur(14px)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            boxSizing: "border-box",
          }}>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowThemePanel(true);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none",
                background: showThemePanel ? "var(--c-adv-choice-bg)" : "transparent",
                color: showThemePanel ? "var(--c-adv-accent)" : "var(--c-adv-text)",
                fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <Palette size={16} color="var(--c-adv-accent)" />
              <span>主题设置</span>
            </button>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowSaveConfirm(true);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none", background: "transparent",
                color: "var(--c-adv-text)", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit",
                cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <Save size={16} color="var(--c-adv-accent)" />
              <span>存档管理</span>
            </button>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowJournal(!showJournal);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none",
                background: showJournal ? "var(--c-adv-choice-bg)" : "transparent",
                color: showJournal ? "var(--c-adv-accent)" : "var(--c-adv-text)",
                fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <BookOpen size={16} color="var(--c-adv-accent)" />
              <span>冒险日志</span>
            </button>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowDebug(!showDebug);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none",
                background: showDebug ? "var(--c-adv-choice-bg)" : "transparent",
                color: showDebug ? "var(--c-adv-accent)" : "var(--c-adv-text)",
                fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <Bug size={16} color="var(--c-adv-accent)" />
              <span>调试记录</span>
            </button>
          </div>
        </>
      )}

      {/* World events collapsible */}
      {worldEvents.length > 0 && (
        <div style={{
          padding: "0 12px", flexShrink: 0,
          borderBottom: showWorldEvents ? "1px solid var(--c-adv-input-bg)" : "none",
        }}>
          <button onClick={() => setShowWorldEvents(!showWorldEvents)} style={{
            width: "100%", padding: "5px 0",
            background: "none", border: "none",
            fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", cursor: "pointer",
            fontFamily: "monospace", letterSpacing: "0.1em",
            textAlign: "center",
          }}>
            🌍 世界动态 {showWorldEvents ? "▲" : "▼"}
          </button>
          {showWorldEvents && (
            <div style={{ padding: "0 4px 8px", maxHeight: 120, overflowY: "auto" }}>
              {worldEvents.map((evt, i) => (
                <div key={i} style={{
                  fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", lineHeight: 1.5,
                  padding: "3px 0",
                  borderBottom: i < worldEvents.length - 1 ? "1px solid var(--c-adv-input-bg)" : "none",
                }}>
                  {evt}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ Text Stream ═══ */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "transparent", display: "flex", flexDirection: "column", zIndex: 1 }}>
        <MapTextStream
          messages={streamMessages}
          avatarMap={avatarMap}
          fontFamily={customFontFamily}
          fontScale={worldTheme.fontScale}
          lineHeightScale={worldTheme.lineHeightScale}
          bilingualTranslationEnabled={bilingualTranslationEnabled}
          defaultTranslationExpanded={defaultTranslationExpanded}
          loading={eventLoading || eventContinueLoading}
          loadingText={eventLoading ? "DM 正在书写命运..." : loadingPhase === "companions" ? "同伴思考中..." : loadingPhase === "dm" ? "DM 裁决中..." : undefined}
        />
      </div>

      {/* ═══ Bottom Action Bar ═══ */}
      {save.completed ? (
        <div style={{
          padding: "14px 12px calc(env(safe-area-inset-bottom, 0px) + 14px)",
          background: "var(--c-adv-bar-bg)",
          backdropFilter: "none",
          borderTop: "1px solid var(--c-adv-accent-dim)",
          textAlign: "center",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", letterSpacing: "0.15em", fontFamily: "monospace" }}>
            — 冒险已完结 —
          </div>
        </div>
      ) : (
        <div style={{
          padding: "8px 12px calc(env(safe-area-inset-bottom, 0px) + 8px)",
          background: "var(--c-adv-bar-bg)",
          backdropFilter: "none",
          borderTop: "1px solid var(--c-adv-bar-border)",
          flexShrink: 0,
        }}>
          {/* Event choices (only during event with choices) */}
          <style>{`
          .map-choice-btn {
            transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease;
          }
          .map-choice-btn:active:not(:disabled) {
            transform: scale(0.97);
            background: rgba(200,160,100,0.12) !important;
            border-color: rgba(200,160,100,0.3) !important;
          }
        `}</style>
          {/* Retry button after API error (shows above choices) */}
          {inEvent && !freeMode && lastFailedAction && currentChoices && currentChoices.length > 0 && !eventContinueLoading && (
            <button onClick={() => {
              const action = lastFailedAction;
              setLastFailedAction(null);
              handlePlayerAction(action, true);
            }} style={{
              width: "100%", padding: "8px 0", borderRadius: 8, marginBottom: 5,
              border: "1px solid rgba(255,160,80,0.2)",
              background: "rgba(255,160,80,0.08)",
              color: "rgba(255,180,100,0.8)",
              fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
              <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🔄</span> 重新生成（原操作）
            </button>
          )}
          {inEvent && !freeMode && currentChoices && currentChoices.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 5 }}>
              {currentChoices.map((choice, i) => {
                const missingItem = choice.requires && !save.director.keyItems.includes(choice.requires);
                return (
                  <button key={i}
                    className="map-choice-btn"
                    onClick={() => {
                      if (missingItem) {
                        pushMessages({ id: mkId(), type: "system", text: `缺少物品「${choice.requires}」，无法执行该行动` });
                        handlePlayerAction(`${choice.label}（缺少${choice.requires}，失败）`);
                        return;
                      }
                      handleChoiceClick(choice);
                    }}
                    disabled={eventContinueLoading}
                    style={{
                      width: "100%", padding: "9px 12px", borderRadius: 8,
                      border: `1px solid ${missingItem ? "rgba(255,80,60,0.15)" : "var(--c-adv-choice-border)"}`,
                      background: missingItem ? "rgba(255,80,60,0.04)" : "var(--c-adv-choice-bg)",
                      color: eventContinueLoading ? "var(--c-adv-text-muted)" : missingItem ? "var(--c-adv-icon)" : "var(--c-adv-body)",
                      fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer",
                      lineHeight: 1.4, textAlign: "left",
                    }}>
                    {choice.statCheck && (
                      <span style={{
                        fontSize: "calc(9px*var(--app-text-scale,1))", padding: "1px 5px", borderRadius: 3, marginRight: 5,
                        background: "var(--c-adv-choice-bg)", color: "var(--c-adv-accent-dim)",
                      }}>
                        🎲 {STAT_LABELS[choice.statCheck.stat] || choice.statCheck.stat}{choice.statCheck.who ? ` · ${choice.statCheck.who}` : ""}
                      </span>
                    )}
                    {choice.requires && (
                      <span style={{
                        fontSize: "calc(9px*var(--app-text-scale,1))", padding: "1px 5px", borderRadius: 3, marginRight: 5,
                        background: missingItem ? "rgba(255,80,60,0.12)" : "rgba(100,200,100,0.12)",
                        color: missingItem ? "rgba(255,100,80,0.7)" : "rgba(100,200,100,0.7)",
                      }}>
                        {missingItem ? "🔒" : "✓"} {choice.requires}
                      </span>
                    )}
                    {choice.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Exploration buttons (only when NOT in event and NOT free mode) */}
          {!inEvent && !freeMode && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 5 }}>
              {currentInteractions.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {currentInteractions.map((ia, i) => (
                    <button key={i} disabled={!ia.available || eventLoading}
                      onClick={() => handleInteraction(ia)}
                      style={{
                        padding: "6px 11px", borderRadius: 7,
                        border: "1px solid var(--c-adv-choice-border)",
                        background: ia.available ? "var(--c-adv-input-bg)" : "transparent",
                        color: ia.available ? "var(--c-adv-text)" : "var(--c-adv-text-muted)",
                        fontSize: "calc(12px*var(--app-text-scale,1))", cursor: ia.available ? "pointer" : "default",
                        fontFamily: "inherit",
                        display: "flex", alignItems: "center", gap: 5,
                      }}>
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))" }}>{ia.icon}</span>
                      <span>{ia.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Retry button on failure */}
          {lastFailedEvent && !eventLoading && !inEvent && (
            <button onClick={() => {
              const { type, brief, meta } = lastFailedEvent;
              setLastFailedEvent(null);
              triggerEvent(type as "main_quest" | "side_quest" | "encounter" | "search" | "talk", brief, meta);
            }} style={{
              width: "100%", padding: "8px 0", borderRadius: 8, marginBottom: 5,
              border: "1px solid rgba(255,160,80,0.2)",
              background: "rgba(255,160,80,0.08)",
              color: "rgba(255,180,100,0.8)",
              fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
              <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🔄</span> 重新生成
            </button>
          )}


          {/* Stuck state recovery: in event, not loading, no choices */}
          {inEvent && !eventLoading && !eventContinueLoading
            && (!currentChoices || currentChoices.length === 0) && (
              <div style={{
                display: "flex", gap: 6, marginBottom: 5,
              }}>
                {lastFailedAction && eventContext ? (
                  <button onClick={() => {
                    const action = lastFailedAction;
                    setLastFailedAction(null);
                    handlePlayerAction(action, true);
                  }} style={{
                    flex: 1, padding: "8px 0", borderRadius: 8,
                    border: "1px solid rgba(255,160,80,0.2)",
                    background: "rgba(255,160,80,0.08)",
                    color: "rgba(255,180,100,0.8)",
                    fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}>
                    <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🔄</span> 继续生成
                  </button>
                ) : (
                  <button onClick={() => {
                    pushMessages({ id: mkId(), type: "system", text: "—— 连接中断，已恢复探索 ——" });
                    setInEvent(false);
                    setCurrentChoices(null);
                    setActiveEvent(null);
                    setActiveEventMeta(null);
                    setAccumulatedEvent(null);
                    setLastFailedAction(null);                  }} style={{
                    flex: 1, padding: "8px 0", borderRadius: 8,
                    border: "1px solid var(--c-adv-input-border)",
                    background: "var(--c-adv-input-bg)",
                    color: "var(--c-adv-text-dim)",
                    fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  }}>
                    ⚠ 生成中断了，点击恢复探索
                  </button>
                )}
              </div>
            )}

          {/* ── Mode indicator ── */}
          {!eventLoading && !eventContinueLoading && (
            <div style={{
              fontSize: "calc(9px*var(--app-text-scale,1))", color: freeMode ? "rgba(100,180,255,0.5)" : "var(--c-adv-accent-dim)",
              fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 4,
              textAlign: "center",
            }}>
              {freeMode ? "自由交流中 — 输入后点击角色头像发送" : inEvent ? "事件进行中" : ""}
            </div>
          )}

          {/* ── Input area (hidden during loading) ── */}
          {!eventLoading && !eventContinueLoading && <div style={{ display: "grid", gridTemplateColumns: "1fr 48px", gap: 6 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
              {/* Speech input */}
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", lineHeight: "32px", flexShrink: 0, width: 20, textAlign: "center" }}>💬</span>
                <input
                  ref={inputRef}
                  value={freeText}
                  onChange={e => setFreeText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !freeMode) handleFreeInput();
                  }}
                  placeholder="说..."
                  disabled={eventContinueLoading || eventLoading || freeModeReplying}
                  style={{
                    flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 8,
                    border: `1px solid ${freeMode ? "rgba(100,180,255,0.12)" : "var(--c-adv-input-border)"}`,
                    background: "var(--c-adv-input-bg)",
                    color: "var(--c-adv-body)",
                    fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none",
                  }}
                />
              </div>

              {/* Action input */}
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", lineHeight: "32px", flexShrink: 0, width: 20, textAlign: "center" }}>⚔</span>
                <input
                  value={freeAction}
                  onChange={e => setFreeAction(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !freeMode) handleFreeInput();
                  }}
                  placeholder="做..."
                  disabled={eventContinueLoading || eventLoading || freeModeReplying}
                  style={{
                    flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 8,
                    border: `1px solid ${freeMode ? "rgba(100,180,255,0.12)" : "var(--c-adv-input-border)"}`,
                    background: "var(--c-adv-input-bg)",
                    color: "var(--c-adv-body)",
                    fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none",
                  }}
                />
              </div>
            </div>

            <button
              type="button"
              aria-label="发送行动"
              onClick={submitFreeInput}
              disabled={(!freeText.trim() && !freeAction.trim()) || eventContinueLoading || eventLoading || freeModeReplying}
              style={{
                width: 48,
                minHeight: 69,
                borderRadius: 9,
                border: "none",
                background: (freeText.trim() || freeAction.trim()) ? "var(--c-adv-accent-dim)" : "var(--c-adv-input-bg)",
                color: (freeText.trim() || freeAction.trim()) ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)",
                cursor: (freeText.trim() || freeAction.trim()) && !freeModeReplying ? "pointer" : "default",
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
              }}
            >
              <Send size={18} />
            </button>

            {/* Free mode: companion avatar row */}
            {freeMode && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 0" }}>
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  {save.agents
                    .map(a => {
                      const ch = characters.find(c => c.id === a.characterId);
                      if (!ch) return null;
                      return (
                        <button key={a.characterId}
                          onClick={() => handleFreeModeChat(a.characterId)}
                          disabled={freeModeReplying}
                          style={{
                            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                            padding: "4px 6px", borderRadius: 8, border: "none", outline: "none",
                            background: "transparent", cursor: "pointer",
                            opacity: freeModeReplying ? 0.35 : 1,
                            WebkitTapHighlightColor: "transparent",
                          }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: "50%",
                            backgroundImage: ch.avatar ? `url(${ch.avatar})` : "none",
                            backgroundColor: ch.avatar ? "transparent" : "var(--c-adv-choice-bg)",
                            backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat",
                            border: "1.5px solid var(--c-adv-accent-dim)",
                          }} />
                          <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-icon)" }}>{ch.name}</span>
                        </button>
                      );
                    })}
                </div>
                {freeModeReplying && (
                  <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(100,180,255,0.5)", textAlign: "center", fontFamily: "monospace" }}>
                    思考中...
                  </div>
                )}
              </div>
            )}
          </div>}
        </div>
      )}

      {/* ═══ Overlays ═══ */}

      {/* Picker Overlay — who rolls this round */}
      {pickerOverlay && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 55,
          background: "rgba(5,5,10,0.7)", backdropFilter: "blur(6px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            width: 280, padding: "32px 20px",
            background: "var(--c-adv-panel-bg)",
            borderRadius: 24,
            border: "1px solid var(--c-adv-accent-dim)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 20,
          }}>
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", letterSpacing: "0.2em", fontFamily: "monospace" }}>
              谁来掷骰子？
            </div>
            <div style={{
              fontSize: "calc(28px*var(--app-text-scale,1))", fontWeight: 700, color: pickerOverlay.settled ? "var(--c-adv-accent)" : "var(--c-adv-text)",
              letterSpacing: "0.1em",
              transition: pickerOverlay.settled ? "color 0.3s, transform 0.3s" : "none",
              transform: pickerOverlay.settled ? "scale(1.2)" : "scale(1)",
            }}>
              {pickerOverlay.current}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {pickerOverlay.candidates.map(name => (
                <div key={name} style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: name === pickerOverlay.current
                    ? (pickerOverlay.settled ? "var(--c-adv-accent)" : "var(--c-adv-text-dim)")
                    : "var(--c-adv-text-muted)",
                  transition: "background 0.1s",
                }} />
              ))}
            </div>
            {pickerOverlay.settled && (
              <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", letterSpacing: "0.15em" }}>
                🎲 就是你了！
              </div>
            )}
          </div>
        </div>
      )}

      {/* Unified Dice Roll Overlay — 3D Cube (player manual / character auto) */}
      {diceOverlay && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 50,
          background: "rgba(5,5,10,0.7)", backdropFilter: "blur(6px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: "overlay-fade-in 0.3s ease-out",
        }}>
          <div style={{
            width: 280, padding: "32px 20px",
            background: "var(--c-adv-panel-bg)",
            borderRadius: 24,
            border: "1px solid var(--c-adv-accent-dim)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
            animation: "popup-zoom-in 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards",
          }}>
            <style>{`
              @keyframes overlay-fade-in { from { opacity: 0; } to { opacity: 1; } }
              @keyframes popup-zoom-in { from { opacity: 0; transform: scale(0.9) translateY(20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
              .dice-scene { perspective: 600px; width: 72px; height: 72px; }
              .dice-cube { width: 100%; height: 100%; position: relative; transform-style: preserve-3d; transform: rotateX(-20deg) rotateY(30deg); transition: transform 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
              .dice-cube.rolling { animation: dice-toss 1.4s linear forwards; }
              .dice-cube.landed { animation: none; transform: rotateX(15deg) rotateY(15deg); }
              .dice-face { position: absolute; width: 72px; height: 72px; display: flex; align-items: center; justify-content: center; border-radius: 12px; background: var(--c-adv-panel-bg); border: 1px solid var(--c-adv-accent-dim); box-shadow: inset 0 0 16px rgba(0,0,0,0.5), 0 0 12px rgba(0,0,0,0.3); font-size: calc(24px*var(--app-text-scale,1)); font-weight: 800; font-family: 'Georgia', serif; color: var(--c-adv-accent); text-shadow: 0 2px 4px rgba(0,0,0,0.5); backface-visibility: hidden; }
              .dice-face::before { content: ''; position: absolute; inset: 2px; border-radius: 10px; border: 1px dashed var(--c-adv-text-muted); pointer-events: none; }
              .dice-face.front  { transform: translateZ(36px); }
              .dice-face.back   { transform: rotateY(180deg) translateZ(36px); }
              .dice-face.right  { transform: rotateY(90deg) translateZ(36px); }
              .dice-face.left   { transform: rotateY(-90deg) translateZ(36px); }
              .dice-face.top    { transform: rotateX(90deg) translateZ(36px); }
              .dice-face.bottom { transform: rotateX(-90deg) translateZ(36px); }
              @keyframes dice-toss {
                0%   { transform: translateY(0) scale(1) rotateX(0deg) rotateY(0deg); }
                35%  { transform: translateY(-130px) scale(1.15) rotateX(360deg) rotateY(120deg); }
                65%  { transform: translateY(10px) scale(0.9) rotateX(720deg) rotateY(240deg); }
                85%  { transform: translateY(-20px) scale(1.05) rotateX(940deg) rotateY(320deg); }
                100% { transform: translateY(0) scale(1) rotateX(1095deg) rotateY(375deg); }
              }
              @keyframes result-pop { 0% { transform: scale(0.8) translateY(15px); opacity: 0; } 50% { transform: scale(1.1) translateY(-5px); } 100% { transform: scale(1) translateY(0); opacity: 1; } }
              @keyframes text-glow { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }
              .roll-btn { padding: 14px 40px; border-radius: 100px; background: var(--c-adv-accent-dim); border: 1px solid var(--c-adv-accent); color: var(--c-adv-accent); font-size: calc(16px*var(--app-text-scale,1)); font-weight: 700; letter-spacing: 0.25em; cursor: pointer; font-family: inherit; box-shadow: 0 8px 32px rgba(0,0,0,0.15); transition: all 0.2s; position: relative; overflow: hidden; width: 100%; box-sizing: border-box; }
              .roll-btn:hover { transform: translateY(-2px); opacity: 0.9; }
              .roll-btn:active { transform: translateY(1px); opacity: 0.8; }
            `}</style>

            {/* Who is rolling */}
            <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", letterSpacing: "0.15em" }}>
              {diceOverlay.name}
            </div>

            {/* Stat info */}
            <div style={{
              fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", letterSpacing: "0.15em",
              background: "var(--c-adv-input-bg)", padding: "6px 16px", borderRadius: 20,
              border: "1px solid var(--c-adv-input-border)",
            }}>
              <span style={{ color: "var(--c-adv-accent)" }}>{diceOverlay.label}</span> 判定 · 属性 <span style={{ color: "var(--c-adv-accent)" }}>{diceOverlay.statValue}</span>
            </div>

            {/* 3D Dice Cube */}
            {(diceRolling || diceNumber > 0) && (
              <div style={{ position: "relative", margin: "8px 0" }}>
                <div className="dice-scene">
                  <div className={`dice-cube ${diceRolling ? "rolling" : diceNumber ? "landed" : ""}`}>
                    {["front", "back", "right", "left", "top", "bottom"].map(face => (
                      <div key={face} className={`dice-face ${face}`}>
                        {diceNumber || "?"}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Big result number after landing */}
            {!diceRolling && diceNumber > 0 ? (
              <div style={{
                fontSize: "calc(48px*var(--app-text-scale,1))", fontWeight: 900, fontFamily: "'Georgia', serif",
                color: "var(--c-adv-accent)", letterSpacing: "-1px",
                animation: "result-pop 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards, text-glow 2.5s ease-in-out infinite alternate",
              }}>
                {diceNumber}
              </div>
            ) : !diceRolling && diceNumber === 0 ? (
              <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", fontFamily: "monospace", letterSpacing: "0.25em" }}>
                D100 SYSTEM
              </div>
            ) : null}

            {/* Controls */}
            <div style={{ width: "100%", marginTop: 4 }}>
              {/* Player: manual roll button */}
              {diceOverlay.isPlayer && diceWaitingClick && (
                <button className="roll-btn" onClick={() => { if (diceResolveRef.current) diceResolveRef.current({ roll: 0, level: "" }); }}>
                  🎲 掷骰子
                </button>
              )}

              {/* Character: auto-roll indicator */}
              {!diceOverlay.isPlayer && !diceRolling && diceNumber === 0 && (
                <div style={{
                  fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", fontFamily: "monospace",
                  letterSpacing: "0.1em", textAlign: "center", padding: "10px 0",
                }}>
                  {diceOverlay.name} 投掷中...
                </div>
              )}

              {/* Rolling status */}
              {diceRolling && (
                <div style={{
                  fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", letterSpacing: "0.15em",
                  padding: "10px 0", textAlign: "center",
                  background: "var(--c-adv-input-bg)", borderRadius: 100,
                  border: "1px solid var(--c-adv-input-border)", width: "100%",
                }}>
                  命运判定中...
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ Theme Panel ═══ */}
      {showThemePanel && (<>
        {/* Backdrop to close on outside click */}
        <div
          onClick={() => setShowThemePanel(false)}
          style={{ position: "absolute", inset: 0, zIndex: 44 }}
        />
        <div style={{
          position: "absolute", top: 90, right: 10, zIndex: 45,
          width: "min(280px, calc(100% - 20px))",
          background: "var(--c-adv-panel-bg)", borderRadius: 12,
          border: "1px solid var(--c-adv-input-border)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
          padding: 14, maxHeight: "60vh", overflowY: "auto",
        }}>
          <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 10, letterSpacing: "0.1em" }}>主题设置</div>

          {/* Color scheme */}
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 6 }}>配色</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 12 }}>
            {ADVENTURE_THEMES.map((s, i) => (
              <button key={i} onClick={() => { const t = { ...worldTheme, colorScheme: i }; setWorldTheme(t); saveWorldTheme(world.id, t); }}
                style={{
                  padding: "6px 0", borderRadius: 6, fontSize: "calc(10px*var(--app-text-scale,1))",
                  border: `1px solid ${(worldTheme.colorScheme ?? 0) === i ? "var(--c-adv-accent-dim)" : "var(--c-adv-input-border)"}`,
                  background: (worldTheme.colorScheme ?? 0) === i ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                  color: s.preview, cursor: "pointer", fontFamily: "inherit",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.preview, flexShrink: 0 }} />
                {s.name}
              </button>
            ))}
          </div>

          {/* Custom font */}
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 6 }}>字体 {worldTheme.customFontName && <span style={{ color: "var(--c-adv-accent-dim)" }}>· {worldTheme.customFontName}</span>}</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <label style={{
              flex: 1, padding: "6px 0", borderRadius: 6, textAlign: "center",
              border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)",
              color: "var(--c-adv-text-dim)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer",
            }}>
              上传字体
              <input type="file" accept=".ttf,.otf,.woff,.woff2,font/*,application/octet-stream" hidden onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => { const t = { ...worldTheme, customFont: reader.result as string, customFontName: file.name }; setWorldTheme(t); saveWorldTheme(world.id, t); };
                reader.readAsDataURL(file);
              }} />
            </label>
            {worldTheme.customFont && (
              <button onClick={() => { const t = { ...worldTheme, customFont: undefined, customFontName: undefined }; setWorldTheme(t); saveWorldTheme(world.id, t); }}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,100,80,0.2)", background: "transparent", color: "rgba(255,100,80,0.6)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer" }}>
                清除
              </button>
            )}
          </div>

          {/* Font scale */}
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4 }}>文字大小 <span style={{ color: "var(--c-adv-accent-dim)" }}>{Math.round((worldTheme.fontScale || 1) * 100)}%</span></div>
          <input type="range" className="adv-slider" min="0.7" max="1.5" step="any" value={worldTheme.fontScale || 1}
            onChange={e => { const t = { ...worldTheme, fontScale: parseFloat(e.target.value) }; setWorldTheme(t); saveWorldTheme(world.id, t); }} />

          {/* Line height scale */}
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4 }}>行间距 <span style={{ color: "var(--c-adv-accent-dim)" }}>{Math.round((worldTheme.lineHeightScale || 1) * 100)}%</span></div>
          <input type="range" className="adv-slider" min="0.8" max="2.0" step="any" value={worldTheme.lineHeightScale || 1}
            onChange={e => { const t = { ...worldTheme, lineHeightScale: parseFloat(e.target.value) }; setWorldTheme(t); saveWorldTheme(world.id, t); }} />

        </div>
      </>)}

      {/* ═══ Floating Actions + Tool Drawer Handle ═══ */}
      {!showToolPanel && (<>
        {/* Direct resolve button (free mode + in event) */}
        {!save.completed && save.agents.length > 0 && freeMode && inEvent && (
          <button onClick={handleDirectResolve} style={{
            position: "absolute", right: 10, bottom: 282, zIndex: 40,
            width: 44, height: 44, borderRadius: "50%",
            background: "rgba(255,180,80,0.2)",
            border: "1px solid rgba(255,180,80,0.4)",
            backdropFilter: "blur(8px)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            color: "var(--c-adv-accent)",
            fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit", fontWeight: 500,
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            裁决
          </button>
        )}
        {/* Event action drawer handle */}
        {showEventActionHandle && (
          <button
            type="button"
            aria-label="打开事件操作"
            aria-expanded={showEventActionDrawer}
            onClick={() => setShowEventActionDrawer(prev => !prev)}
            style={{
              position: "absolute",
              right: 0,
              top: "calc(50% + 78px)",
              transform: "translateY(-50%)",
              zIndex: 40,
              width: 30,
              minHeight: 54,
              borderRadius: "14px 0 0 14px",
              background: "var(--c-adv-bar-bg)",
              border: "1px solid var(--c-adv-accent-dim)",
              borderRight: "none",
              backdropFilter: "blur(10px)",
              boxShadow: "-1px 0 5px rgba(0,0,0,0.08)",
              color: "var(--c-adv-accent-dim)",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
        {showEventActionDrawer && showEventActionHandle && (
          <>
            <div
              onClick={() => setShowEventActionDrawer(false)}
              style={{ position: "absolute", inset: 0, zIndex: 41 }}
            />
            <div
              role="dialog"
              aria-label="事件操作"
              style={{
                position: "absolute",
                right: 0,
                top: "calc(50% + 42px)",
                zIndex: 42,
                width: "min(256px, 78%)",
                maxHeight: "calc(100% - 210px)",
                overflowY: "auto",
                padding: 10,
                borderRadius: "16px 0 0 16px",
                border: "1px solid var(--c-adv-input-border)",
                borderRight: "none",
                background: "var(--c-adv-bar-bg)",
                backdropFilter: "blur(12px)",
                boxShadow: "-2px 0 10px rgba(0,0,0,0.08)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {canToggleFreeMode && (
                <button
                  type="button"
                  onClick={handleToggleFreeMode}
                  style={{
                    width: "100%",
                    padding: "10px 11px",
                    borderRadius: 12,
                    border: `1px solid ${freeMode ? "rgba(100,180,255,0.35)" : "var(--c-adv-input-border)"}`,
                    background: freeMode ? "rgba(100,180,255,0.12)" : "var(--c-adv-input-bg)",
                    color: "var(--c-adv-text)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <MessageCircle size={17} color={freeMode ? "rgba(100,180,255,0.9)" : "var(--c-adv-accent)"} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 700, lineHeight: 1.25 }}>
                      {freeMode ? "结束自由交流" : "自由交流"}
                    </span>
                    <span style={{ display: "block", marginTop: 4, fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", lineHeight: 1.45 }}>
                      {freeMode ? "回到正常事件行动与 DM 裁决流程。" : "先和同伴对话，暂不推进 DM 裁决。"}
                    </span>
                  </span>
                </button>
              )}
              {canExitCurrentEvent && (
                <button
                  type="button"
                  onClick={() => {
                    setShowEventActionDrawer(false);
                    handleEventExit();
                  }}
                  style={{
                    width: "100%",
                    padding: "10px 11px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,80,60,0.18)",
                    background: "rgba(255,80,60,0.06)",
                    color: "var(--c-adv-text)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <LogOut size={17} color="rgba(255,90,70,0.62)" style={{ marginTop: 1, flexShrink: 0 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 700, lineHeight: 1.25 }}>退出事件</span>
                    <span style={{ display: "block", marginTop: 4, fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", lineHeight: 1.45 }}>
                      离开当前事件，回到探索状态。
                    </span>
                  </span>
                </button>
              )}
            </div>
          </>
        )}
        {/* Tool drawer handle */}
        <button
          type="button"
          aria-label="打开冒险工具栏"
          onClick={() => {
            setShowEventActionDrawer(false);
            setShowToolPanel(true);
          }}
          style={{
            position: "absolute",
            right: 0,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 40,
            width: 30,
            minHeight: 76,
            borderRadius: "14px 0 0 14px",
            background: "var(--c-adv-bar-bg)",
            border: "1px solid var(--c-adv-accent-dim)",
            borderRight: "none",
            backdropFilter: "blur(10px)",
            boxShadow: "-1px 0 5px rgba(0,0,0,0.08)",
            color: "var(--c-adv-accent)",
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 0,
            fontFamily: "inherit",
          }}
        >
          <MapIcon size={15} />
        </button>
      </>)}

      {/* ═══ Tool Drawer (Map + Status + Companions) ═══ */}
      {showToolPanel && (
        <>
          {/* Backdrop */}
          <div style={{
            position: "absolute",
            inset: 0,
            zIndex: 39,
            background: "rgba(0,0,0,0.18)",
            backdropFilter: "blur(2px)",
          }} onClick={() => setShowToolPanel(false)} />

          {/* Drawer */}
          <div style={{
            position: "absolute",
            top: "calc(150px + env(safe-area-inset-top, 0px))",
            right: 0,
            bottom: freeMode ? 214 : inEvent ? 191 : 151,
            width: "min(360px, 82%)",
            zIndex: 40,
            background: "var(--c-adv-bar-bg)",
            border: "1px solid var(--c-adv-input-border)",
            borderRight: "none",
            borderRadius: "20px 0 0 20px",
            boxShadow: "-2px 0 10px rgba(0,0,0,0.08)",
            backdropFilter: "blur(12px)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
            animation: "tool-drawer-in 0.24s ease-out",
          }}>
            <style>{`
              @keyframes tool-drawer-in {
                from { opacity: 0.82; transform: translateX(24px); }
                to { opacity: 1; transform: translateX(0); }
              }
            `}</style>

            {/* Tab bar */}
            <div style={{
              display: "flex", borderBottom: "1px solid var(--c-adv-input-border)",
              flexShrink: 0,
            }}>
              {(["map", "bag", "contacts"] as const).map(tab => (
                <button key={tab} onClick={() => setToolTab(tab)}
                  style={{
                    flex: 1, padding: "10px 0",
                    background: "none", border: "none",
                    borderBottom: toolTab === tab ? "2px solid var(--c-adv-accent-dim)" : "2px solid transparent",
                    color: toolTab === tab ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)",
                    fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                    letterSpacing: "0.05em",
                  }}>
                  {tab === "map" ? "🗺 地图" : tab === "bag" ? `📊 状态` : `💬 同伴`}
                </button>
              ))}
              <button onClick={() => setShowToolPanel(false)} style={{
                padding: "10px 14px", background: "none", border: "none",
                color: "var(--c-adv-text-muted)", fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer",
              }}>✕</button>
            </div>

            {/* Tab content */}
            {toolTab === "map" ? (
              <div style={{ flex: 1, position: "relative" }}>
                <MapRenderer
                  data={renderedMap}
                  currentNodeId={save.currentNodeId}
                  selectedNodeId={selectedNodeId}
                  discoveredNodes={save.discoveredNodes}
                  visitedNodes={save.visitedNodes}
                  agentPositions={save.agents.map(a => ({ nodeId: a.currentNodeId, name: charName(a.characterId), avatar: characters.find(c => c.id === a.characterId)?.avatar || undefined }))}
                  playerAvatar={userIdentity?.avatarUrl}
                  playerName={userIdentity?.name || "我"}
                  onNodeClick={(id) => {
                    if (!inEvent && !eventLoading) {
                      setSelectedNodeId(id === selectedNodeId ? null : id);
                    }
                  }}
                />
                {/* Selected node info at bottom of map */}
                {selectedNode && !inEvent && !eventLoading && (() => {
                  // Find node content from richRegions
                  const region = skeleton.richRegions[selectedNode.regionIdx];
                  let nodeContent: import("@/lib/map-types").NodeContent | undefined;
                  if (selectedNode.type === "l2") {
                    nodeContent = region?.l2_nodes.find(n => n.name === selectedNode.name);
                  } else if (selectedNode.type === "l3") {
                    nodeContent = region?.l3_nodes.find(n => n.name === selectedNode.name);
                  }
                  const l1Npc = selectedNode.type === "l1" ? region?.l1_npc : undefined;
                  const l1Quest = selectedNode.type === "l1" ? region?.l1_quest : undefined;
                  const npc = nodeContent?.npc || l1Npc;
                  const quest = nodeContent?.quest || l1Quest;
                  const encounter = nodeContent?.encounter;

                  return (
                    <div style={{
                      position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10,
                      padding: "10px 12px",
                      background: "linear-gradient(transparent, var(--c-adv-bar-bg) 30%)",
                    }}>
                      {/* Header */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                          <span style={{ fontSize: "calc(8px*var(--app-text-scale,1))", padding: "1px 4px", borderRadius: 3, background: "var(--c-adv-input-border)", color: "var(--c-adv-text-muted)", fontFamily: "monospace", flexShrink: 0 }}>{selectedNode.type.toUpperCase()}</span>
                          <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 600, color: "var(--c-adv-accent)", whiteSpace: "nowrap" }}>{selectedNode.name}</span>
                          {selectedNode.id === save.currentNodeId && (
                            <span style={{ fontSize: "calc(8px*var(--app-text-scale,1))", padding: "1px 4px", borderRadius: 3, background: "var(--c-adv-accent-dim)", color: "var(--c-adv-accent-dim)", fontFamily: "monospace", flexShrink: 0 }}>HERE</span>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                          {selectedNode.id !== save.currentNodeId && isVisible(selectedNode.id) && nearbyNodes.some(n => n.id === selectedNode.id) && (
                            <button onClick={() => { handleMoveWithAgents(selectedNode.id); setShowToolPanel(false); }}
                              style={{
                                padding: "5px 10px", borderRadius: 6,
                                border: "1px solid var(--c-adv-accent-dim)",
                                background: "var(--c-adv-choice-bg)",
                                color: "var(--c-adv-accent)",
                                fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                              }}>
                              前往
                            </button>
                          )}
                          <button onClick={() => setSelectedNodeId(null)} style={{
                            background: "none", border: "none", color: "var(--c-adv-text-muted)",
                            fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer",
                          }}>✕</button>
                        </div>
                      </div>
                      {/* Details */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {npc && (
                          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", lineHeight: 1.4 }}>
                            <span style={{ color: "var(--c-adv-accent-dim)" }}>💬 {npc.name}</span>
                            <span style={{ color: "var(--c-adv-text-muted)", marginLeft: 4 }}>{npc.personality.length > 40 ? npc.personality.slice(0, 40) + "..." : npc.personality}</span>
                          </div>
                        )}
                        {quest && (
                          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)" }}>
                            <span style={{ color: "rgba(140,200,140,0.6)" }}>📋 {quest.title}</span>
                            <span style={{ color: "var(--c-adv-text-muted)", marginLeft: 4 }}>{quest.brief}</span>
                          </div>
                        )}
                        {encounter && (
                          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)" }}>
                            <span style={{ color: "rgba(200,140,140,0.6)" }}>⚡ {encounter.mood}</span>
                            <span style={{ color: "var(--c-adv-text-muted)", marginLeft: 4 }}>{encounter.brief}</span>
                          </div>
                        )}
                        {!npc && !quest && !encounter && (
                          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)" }}>暂无特殊内容</div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : toolTab === "bag" ? (
              /* Bag tab */
              <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
                {/* Player stats */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>属性</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                  {ALL_STATS.map(k => (
                    <div key={k} style={{
                      padding: "5px 8px", borderRadius: 6,
                      background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)",
                      fontSize: "calc(11px*var(--app-text-scale,1))", textAlign: "center", minWidth: 60,
                    }}>
                      <div style={{ color: "var(--c-adv-text-muted)", fontSize: "calc(9px*var(--app-text-scale,1))" }}>{STAT_LABELS[k]}</div>
                      <div style={{ color: "var(--c-adv-accent)", fontWeight: 600, marginTop: 2 }}>{save.playerStats?.[k] ?? "?"}</div>
                    </div>
                  ))}
                </div>

                {/* Items */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>物品栏</div>
                {save.director.keyItems.length === 0 ? (
                  <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", textAlign: "center", padding: "20px 0" }}>
                    空空如也~
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {save.director.keyItems.map((item, i) => (
                      <div key={i} style={{
                        padding: "7px 10px", borderRadius: 6,
                        background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)",
                        fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-body)",
                      }}>
                        {item}
                      </div>
                    ))}
                  </div>
                )}

                {/* Pacing control */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 14, marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>剧情节奏</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {([["relaxed", "悠闲"], ["normal", "适中"], ["fast", "紧凑"]] as const).map(([val, label]) => (
                    <button key={val} onClick={() => persistSave({ ...save, pacing: val })}
                      style={{
                        flex: 1, padding: "6px 0", borderRadius: 6, fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit",
                        border: `1px solid ${(save.pacing || "normal") === val ? "var(--c-adv-accent-dim)" : "var(--c-adv-input-border)"}`,
                        background: (save.pacing || "normal") === val ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                        color: (save.pacing || "normal") === val ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)",
                        cursor: "pointer",
                      }}>
                      {label}
                    </button>
                  ))}
                </div>

                {/* Manual summary button (for this world) */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 14, marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>冒险总结</div>
                <button onClick={async () => {
                  const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || loadApiConfigs().find(c => c.apiKey);
                  if (!apiConfig?.apiKey) return;
                  pushMessages({ id: mkId(), type: "system", text: "正在总结冒险经历..." });
                  try {
                    await generateAdventureSummary(save, skeleton.world.name, apiConfig);
                    pushMessages({ id: mkId(), type: "system", text: "冒险总结已更新" });
                  } catch (e) {
                    pushMessages({ id: mkId(), type: "system", text: `总结失败：${e instanceof Error ? e.message : String(e)}` });
                  }
                }} style={{
                  width: "100%", padding: "7px 0", borderRadius: 6, marginBottom: 8,
                  border: "1px solid var(--c-adv-accent-dim)", background: "var(--c-adv-choice-bg)",
                  color: "var(--c-adv-accent-dim)", fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  立即总结本次冒险
                </button>

                {/* Game info */}
                <div style={{ marginTop: 14, fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", fontFamily: "monospace" }}>
                  <div>HP {save.hp}/{save.maxHp} · {formatGameTime(save.gameDay, save.gameTime)}</div>
                  <div style={{ marginTop: 2 }}>{currentNode?.name}</div>
                  <div style={{ marginTop: 2 }}>主线 第{Math.min(save.mainQuestStage + 1, skeleton.mainQuest.stages.length)}/{skeleton.mainQuest.stages.length}阶段</div>
                </div>
              </div>
            ) : (
              /* Contacts tab */
              <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
                {save.agents.length === 0 ? (
                  <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", textAlign: "center", padding: "40px 0" }}>
                    没有同伴
                  </div>
                ) : save.agents.map(a => {
                  const name = charName(a.characterId);
                  const nodeName = allNodes.find(n => n.id === a.currentNodeId)?.name || "未知";
                  return (
                    <div key={a.characterId} style={{
                      padding: "8px 10px", borderRadius: 8, marginBottom: 5,
                      border: "1px solid var(--c-adv-input-border)",
                      background: "var(--c-adv-input-bg)",
                    }}>
                      <div style={{ fontWeight: 500, fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text)" }}>{name}</div>
                      <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 2 }}>
                        📍 {nodeName} · HP {a.hp}/{a.maxHp} · ❤️ {a.affinity}
                      </div>
                      <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 1 }}>
                        {ALL_STATS.map(k => `${STAT_LABELS[k]}${a.stats?.[k] ?? "?"}`).join(" ")}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Debug panel */}
      {showDebug && (() => {
        const isChar = (type: string) => type.includes("角色");
        const isRoundStart = (type: string) =>
          type === "发送·system" ||
          type === "DM裁决·system" ||
          type === "DM场景·发送" ||
          type === "DM裁决·发送" ||
          type === "DM结局·发送";

        // Find start of current round. Companion declarations happen before DM resolve,
        // so include the contiguous character calls immediately before the latest DM裁决.
        const roundStartIdx = (() => {
          let dmStartIdx = 0;
          for (let i = debugLog.length - 1; i >= 0; i--) {
            if (isRoundStart(debugLog[i].type)) {
              dmStartIdx = i;
              break;
            }
          }
          if (debugLog[dmStartIdx]?.type === "DM裁决·发送") {
            let start = dmStartIdx;
            while (start > 0 && isChar(debugLog[start - 1].type)) start--;
            return start;
          }
          return dmStartIdx;
        })();

        const filteredLog = (() => {
          if (debugFilter === "current") return debugLog.slice(roundStartIdx);
          if (debugFilter === "dm") return debugLog.filter(log => !isChar(log.type));
          if (debugFilter === "char") return debugLog.filter(log => isChar(log.type));
          return debugLog;
        })();

        const filterCounts: Record<"current" | "dm" | "char" | "all", number> = {
          current: debugLog.slice(roundStartIdx).length,
          dm: debugLog.filter(log => !isChar(log.type)).length,
          char: debugLog.filter(log => isChar(log.type)).length,
          all: debugLog.length,
        };

        const debugFilterTabs = [
          { label: "当前轮", val: "current" },
          { label: "DM", val: "dm" },
          { label: "角色", val: "char" },
          { label: "全部", val: "all" },
        ] as const;

        const tabBtn = (label: string, val: "current" | "dm" | "char" | "all") => {
          const active = debugFilter === val;
          return (
            <button
              key={val}
              type="button"
              onClick={() => setDebugFilter(val)}
              style={{
                minHeight: 44,
                padding: "8px 10px",
                borderRadius: 12,
                border: `1px solid ${active ? "var(--c-adv-accent)" : "var(--c-adv-input-border)"}`,
                background: active ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                color: active ? "var(--c-adv-text)" : "var(--c-adv-text-muted)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 700, lineHeight: 1.2 }}>{label}</span>
              <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: active ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)", lineHeight: 1.2 }}>
                {filterCounts[val]} 条
              </span>
            </button>
          );
        };

        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="调试记录"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 55,
              background: "var(--c-adv-debug-overlay)",
              backdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "max(16px, env(safe-area-inset-top, 0px)) 12px max(16px, env(safe-area-inset-bottom, 0px))",
            }}
          >
            <div
              style={{
                width: "min(680px, 100%)",
                height: "min(760px, 88vh)",
                borderRadius: "var(--c-adv-debug-radius)",
                border: "1px solid var(--c-adv-input-border)",
                background: "var(--c-adv-debug-panel-bg)",
                boxShadow: "var(--c-adv-debug-shadow)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                fontFamily: "var(--adv-font), PingFang SC, system-ui, sans-serif",
              }}
            >
              <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-debug-header-bg)", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "calc(18px*var(--app-text-scale,1))", fontWeight: 800, color: "var(--c-adv-text)", lineHeight: 1.2 }}>调试记录</div>
                    <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 5, lineHeight: 1.4 }}>
                      {debugLog.length > 0 ? `${debugLog.length} 条交互记录` : "触发事件后会显示 LLM 交互记录"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => setDebugLog([])}
                      disabled={debugLog.length === 0}
                      style={{
                        minWidth: 56,
                        minHeight: 44,
                        padding: "0 14px",
                        borderRadius: 14,
                        border: "1px solid var(--c-adv-input-border)",
                        background: "var(--c-adv-input-bg)",
                        color: debugLog.length === 0 ? "var(--c-adv-text-muted)" : "var(--c-adv-text)",
                        fontSize: "calc(13px*var(--app-text-scale,1))",
                        fontWeight: 700,
                        cursor: debugLog.length === 0 ? "default" : "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      清空
                    </button>
                    <button
                      type="button"
                      aria-label="关闭调试记录"
                      onClick={() => setShowDebug(false)}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 14,
                        border: "1px solid var(--c-adv-input-border)",
                        background: "var(--c-adv-input-bg)",
                        color: "var(--c-adv-text)",
                        display: "grid",
                        placeItems: "center",
                        cursor: "pointer",
                      }}
                    >
                      <X size={19} />
                    </button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginTop: 14 }}>
                  {debugFilterTabs.map(tab => tabBtn(tab.label, tab.val))}
                </div>
              </div>

              <div style={{ flex: 1, overflow: "auto", padding: "14px 14px 18px" }}>
                {filteredLog.length === 0 ? (
                  <div style={{ color: "var(--c-adv-text-muted)", fontSize: "calc(13px*var(--app-text-scale,1))", textAlign: "center", padding: "64px 18px" }}>
                    {debugLog.length === 0 ? "当前页面暂无 LLM 交互记录；触发事件或继续行动后会显示。" : "此分类暂无记录"}
                  </div>
                ) : filteredLog.map((log, i) => {
                  const char = isChar(log.type);
                  const isRecv = log.type.includes("返回");
                  const isSystem = log.type.includes("system") || log.type === "配置";
                  const color = char
                    ? "var(--c-adv-debug-char)"
                    : isRecv
                      ? "var(--c-adv-debug-recv)"
                      : isSystem
                        ? "var(--c-adv-debug-system)"
                        : "var(--c-adv-debug-dm)";
                  const bg = char
                    ? "var(--c-adv-debug-char-bg)"
                    : isRecv
                      ? "var(--c-adv-debug-recv-bg)"
                      : isSystem
                        ? "var(--c-adv-debug-system-bg)"
                        : "var(--c-adv-debug-dm-bg)";

                  return (
                    <div
                      key={i}
                      style={{
                        marginBottom: 12,
                        borderRadius: 14,
                        overflow: "hidden",
                        border: "1px solid var(--c-adv-input-border)",
                        background: "var(--c-adv-debug-card-bg)",
                      }}
                    >
                      <div style={{ padding: "10px 12px", background: bg, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, borderBottom: "1px solid var(--c-adv-input-border)" }}>
                        <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 800, color, lineHeight: 1.25, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {log.type}
                        </span>
                        <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", flexShrink: 0 }}>{log.time}</span>
                      </div>
                      <pre style={{
                        fontSize: "calc(12px*var(--app-text-scale,1))",
                        color: "var(--c-adv-text)",
                        margin: 0,
                        padding: "12px",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        overflowWrap: "anywhere",
                        lineHeight: 1.65,
                        maxHeight: debugFilter === "current" ? undefined : 460,
                        overflow: debugFilter === "current" ? "visible" : "auto",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                        background: "var(--c-adv-debug-pre-bg)",
                      }}>
                        {log.content}
                      </pre>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══ Ending Overlay ═══ */}
      {endingData && (
        <div
          onClick={() => {
            if (showFireworks) return;
            const total = endingData.paragraphs.length;
            if (endingStep < total) {
              setEndingStep(endingStep + 1);
            } else if (endingStep === total) {
              // Show closing → fireworks
              setEndingStep(total + 1);
              setShowFireworks(true);
            }
          }}
          style={{
            position: "absolute", inset: 0, zIndex: 70,
            background: "rgba(5,5,10,0.7)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20,
            cursor: showFireworks ? "default" : "pointer",
          }}
        >
          {/* Card popup */}
          <div ref={endingScrollRef} style={{
            maxWidth: 320, width: "100%", maxHeight: "75vh", overflowY: "auto",
            background: "radial-gradient(circle at top, rgba(30,25,20,0.97) 0%, rgba(12,10,15,0.98) 100%)",
            borderRadius: 20, border: "1px solid rgba(220,180,120,0.15)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            padding: "28px 22px",
            display: "flex", flexDirection: "column", gap: 16,
            position: "relative", zIndex: 1,
          }}>
            {endingData.paragraphs.slice(0, endingStep + 1).map((p, i) => (
              <div key={i} style={{
                fontSize: "calc(14px*var(--app-text-scale,1))", lineHeight: 1.8, color: "rgba(255,255,255,0.75)",
                opacity: i === endingStep ? 1 : 0.4,
                transition: "opacity 0.5s",
                whiteSpace: "pre-wrap",
              }}>
                {p}
              </div>
            ))}

            {/* Closing */}
            {endingStep > endingData.paragraphs.length - 1 && (
              <div style={{
                fontSize: "calc(18px*var(--app-text-scale,1))", fontWeight: 600, color: "#f0c060",
                textAlign: "center", marginTop: 12,
                letterSpacing: "0.15em",
                textShadow: "0 0 20px rgba(240,192,96,0.3)",
              }}>
                {endingData.closing}
              </div>
            )}

            {/* Tap hint */}
            {!showFireworks && endingStep <= endingData.paragraphs.length && (
              <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.15)", marginTop: 12, letterSpacing: "0.2em", textAlign: "center" }}>
                点击继续
              </div>
            )}

            {/* Return button (after fireworks, inside card) */}
            {!showFireworks && endingStep > endingData.paragraphs.length && (
              <button onClick={(e) => {
                e.stopPropagation();
                handleArchive();
              }} style={{
                marginTop: 12, padding: "12px 32px", borderRadius: 100, width: "100%",
                background: "linear-gradient(135deg, rgba(220,180,120,0.25), rgba(180,130,70,0.15))",
                border: "1px solid rgba(220,180,120,0.4)",
                color: "#f4dca8", fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 600,
                letterSpacing: "0.2em", cursor: "pointer", fontFamily: "inherit",
              }}>
                完结
              </button>
            )}
          </div>

          {/* Fireworks Canvas — full screen in front of card */}
          {showFireworks && (
            <canvas
              ref={(canvas) => {
                if (!canvas || canvas.dataset.initialized) return;
                canvas.dataset.initialized = "1";

                const dpr = window.devicePixelRatio || 2;
                const parent = canvas.parentElement!;
                const W = parent.clientWidth;
                const H = parent.clientHeight;
                canvas.width = W * dpr;
                canvas.height = H * dpr;
                canvas.style.width = W + "px";
                canvas.style.height = H + "px";
                const ctx = canvas.getContext("2d")!;
                ctx.scale(dpr, dpr);

                type Particle = {
                  x: number; y: number; vx: number; vy: number;
                  life: number; maxLife: number; color: string; size: number;
                  type: "trail" | "spark" | "glitter";
                  prevX: number; prevY: number;
                };
                const particles: Particle[] = [];
                // Each firework picks ONE main color — like real pyrotechnics
                const mainColors = ["#ff4040", "#e8a0ff", "#50ccff", "#50ee90", "#ff7eb3", "#a0b4ff", "#ff9055"];
                const pickMain = () => mainColors[Math.floor(Math.random() * mainColors.length)];

                const launch = () => {
                  const x = W * (0.15 + Math.random() * 0.7);
                  const targetY = H * (0.15 + Math.random() * 0.45);
                  const frames = 22 + Math.floor(Math.random() * 8);
                  const trailColor = "#ffd080";
                  // Launch trail
                  particles.push({
                    x, y: H + 10, vx: (Math.random() - 0.5) * 0.2, vy: -(H - targetY) / frames,
                    life: frames, maxLife: frames, color: trailColor, size: 1.5,
                    type: "trail", prevX: x, prevY: H + 10,
                  });
                  // Explosion
                  setTimeout(() => {
                    const color = pickMain();
                    const count = 70 + Math.floor(Math.random() * 40);
                    const shape = Math.random();
                    for (let i = 0; i < count; i++) {
                      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.15;
                      let speed: number;
                      if (shape < 0.4) speed = 3 + Math.random() * 3.5;          // peony (round)
                      else if (shape < 0.7) speed = 4.5 + Math.random() * 1.5;   // chrysanthemum (uniform)
                      else speed = 1.5 + Math.random() * 5;                       // willow (spread)
                      const life = shape < 0.7 ? 50 + Math.floor(Math.random() * 35) : 65 + Math.floor(Math.random() * 40);
                      // Mostly main color, ~15% white sparks
                      const c = Math.random() < 0.85 ? color : "#ffe8cc";
                      particles.push({
                        x, y: targetY,
                        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.8,
                        life, maxLife: life,
                        color: c, size: 1.2 + Math.random() * 1.2,
                        type: "spark", prevX: x, prevY: targetY,
                      });
                    }
                    // Center flash
                    particles.push({
                      x, y: targetY, vx: 0, vy: 0,
                      life: 8, maxLife: 8, color: "#fff", size: 8,
                      type: "glitter", prevX: x, prevY: targetY,
                    });
                  }, frames * 16);
                };

                // Fewer launches, more spaced out
                let launchCount = 0;
                const intervals: ReturnType<typeof setInterval>[] = [];
                // Wave 1: opening (0-1.5s)
                intervals.push(setInterval(() => {
                  launch();
                  launchCount++;
                  if (launchCount > 3) clearInterval(intervals[0]);
                }, 500));
                // Wave 2: mid climax (1.5-4.5s) — more frequent
                setTimeout(() => {
                  intervals.push(setInterval(() => {
                    launch();
                    launch();
                    if (Math.random() > 0.5) launch();
                    launchCount++;
                    if (launchCount > 12) clearInterval(intervals[1]);
                  }, 600));
                }, 1500);
                // Wave 3: finale burst (4.5-6s)
                setTimeout(() => {
                  intervals.push(setInterval(() => {
                    launch(); launch();
                    launchCount++;
                    if (launchCount > 18) clearInterval(intervals[2]);
                  }, 350));
                }, 4500);

                let animId = 0;
                const animate = () => {
                  // Fade trail (creates afterglow)
                  ctx.globalCompositeOperation = "destination-out";
                  ctx.fillStyle = "rgba(0,0,0,0.08)";
                  ctx.fillRect(0, 0, W, H);
                  ctx.globalCompositeOperation = "lighter"; // additive blending for glow

                  for (let i = particles.length - 1; i >= 0; i--) {
                    const p = particles[i];
                    p.prevX = p.x; p.prevY = p.y;
                    p.x += p.vx;
                    p.y += p.vy;
                    if (p.type !== "trail") p.vy += 0.035;
                    if (p.type === "spark") { p.vx *= 0.985; p.vy *= 0.985; } // air resistance
                    p.life--;
                    // Secondary burst: ~10% of sparks explode again at 40% life remaining
                    if (p.type === "spark" && p.life === Math.floor(p.maxLife * 0.4) && Math.random() < 0.1) {
                      const remaining = p.life;
                      const subCount = 6 + Math.floor(Math.random() * 6);
                      for (let s = 0; s < subCount; s++) {
                        const a = Math.random() * Math.PI * 2;
                        const sp = 1 + Math.random() * 1.5;
                        const subLife = Math.floor(remaining * (0.5 + Math.random() * 0.4));
                        particles.push({
                          x: p.x, y: p.y,
                          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                          life: subLife, maxLife: subLife,
                          color: p.color, size: 0.6 + Math.random() * 0.4,
                          type: "spark", prevX: p.x, prevY: p.y,
                        });
                      }
                    }
                    if (p.life <= 0) { particles.splice(i, 1); continue; }
                    const alpha = p.life / p.maxLife;

                    if (p.type === "trail") {
                      // Rising trail line
                      ctx.globalAlpha = alpha * 0.8;
                      ctx.strokeStyle = p.color;
                      ctx.lineWidth = p.size;
                      ctx.beginPath();
                      ctx.moveTo(p.prevX, p.prevY);
                      ctx.lineTo(p.x, p.y);
                      ctx.stroke();
                    } else if (p.type === "glitter") {
                      // Center flash — fast bright fade
                      ctx.globalAlpha = alpha;
                      ctx.fillStyle = p.color;
                      ctx.beginPath();
                      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
                      ctx.fill();
                    } else {
                      // Spark — draw as short line (motion trail) for realistic streaks
                      const trailLen = Math.sqrt(p.vx * p.vx + p.vy * p.vy) * 2;
                      ctx.globalAlpha = alpha * 0.85;
                      ctx.strokeStyle = p.color;
                      ctx.lineWidth = p.size * alpha;
                      ctx.lineCap = "round";
                      ctx.beginPath();
                      ctx.moveTo(p.x - p.vx * 1.5, p.y - p.vy * 1.5);
                      ctx.lineTo(p.x, p.y);
                      ctx.stroke();
                      // Soft glow at tip
                      ctx.globalAlpha = alpha * 0.12;
                      ctx.fillStyle = p.color;
                      ctx.beginPath();
                      ctx.arc(p.x, p.y, trailLen * 0.6, 0, Math.PI * 2);
                      ctx.fill();
                    }
                  }
                  ctx.globalAlpha = 1;
                  ctx.globalCompositeOperation = "source-over";
                  animId = requestAnimationFrame(animate);
                };
                animate();

                // Stop launching at 6s
                setTimeout(() => {
                  intervals.forEach(clearInterval);
                }, 6000);

                // Wait for particles to die out, then close
                setTimeout(() => {
                  const waitForEmpty = setInterval(() => {
                    if (particles.length === 0) {
                      clearInterval(waitForEmpty);
                      cancelAnimationFrame(animId);
                      setShowFireworks(false);
                    }
                  }, 200);
                  // Safety: force close after 4s
                  setTimeout(() => { cancelAnimationFrame(animId); setShowFireworks(false); }, 4000);
                }, 8000);
              }}
              style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}
            />
          )}

        </div>
      )}

      {/* Death dialog */}
      {showDeathDialog && (
        <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "rgba(15,12,18,0.98)", borderRadius: 16, border: "1px solid rgba(200,60,60,0.2)", padding: 24, maxWidth: 280, width: "100%", textAlign: "center" }}>
            <div style={{ fontSize: "calc(32px*var(--app-text-scale,1))", marginBottom: 12 }}>💀</div>
            <div style={{ fontSize: "calc(16px*var(--app-text-scale,1))", fontWeight: 600, color: "#e0dcd5", marginBottom: 6 }}>你倒下了</div>
            <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.35)", marginBottom: 20, lineHeight: 1.5 }}>
              {save.checkpoint ? "黑暗笼罩了你的意识..." : "没有存档点，冒险到此为止了..."}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {save.checkpoint && (
                <button onClick={() => {
                  try {
                    const cp = JSON.parse(save.checkpoint!) as GameSave;
                    // Restore UI state from checkpoint
                    const restoredStream = [...(cp.streamLog || []), { id: mkId(), type: "system" as const, text: "—— 回到存档点 ——" }];
                    setStreamMessages(restoredStream);
                    setInEvent(cp.pendingEvent?.inEvent || false);
                    setCurrentChoices(cp.pendingEvent?.choices || null);
                    setEventContext(cp.pendingEvent?.eventContext || "");
                    setActiveEventMeta(cp.pendingEvent?.eventMeta || null);
                    setActiveEvent(null);
                    setAccumulatedEvent(null);
                    setLastFailedAction(cp.pendingEvent?.lastAction || null);
                    setCompletedCompanions(cp.pendingEvent?.completedCompanions || []);
                    // Clear transient UI state
                    setLoadingPhase("");
                    setFreeText("");
                    setFreeAction("");
                    setLastFailedEvent(null);
                    // Save directly (bypass persistSave which would inject current refs)
                    const restored: GameSave = { ...cp, streamLog: restoredStream.slice(-200), checkpoint: save.checkpoint };
                    saveGame(restored);
                    onSaveUpdate(restored);
                  } catch {
                    pushMessages({ id: mkId(), type: "system", text: "存档点损坏" });
                  }
                  setShowDeathDialog(false);
                }} style={{
                  padding: "10px 0", borderRadius: 8, border: "1px solid rgba(200,160,100,0.3)",
                  background: "rgba(200,160,100,0.15)", color: "#e8d0a0",
                  fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
                }}>
                  回到存档点
                </button>
              )}
              <button onClick={() => {
                setShowDeathDialog(false);
                onBack();
              }} style={{
                padding: "10px 0", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(255,255,255,0.03)", color: "rgba(255,255,255,0.4)",
                fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              }}>
                放弃冒险
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save checkpoint confirm */}
      {showSaveConfirm && (
        <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
          onClick={() => setShowSaveConfirm(false)}>
          <div style={{ background: "var(--c-adv-panel-bg)", borderRadius: 12, border: `1px solid var(--c-adv-input-border)`, padding: 20, maxWidth: 280, width: "100%" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 600, marginBottom: 6, textAlign: "center", color: "var(--c-adv-text)" }}>保存存档点</div>
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4, textAlign: "center" }}>
              {currentNode?.name} · HP {save.hp}/{save.maxHp}
            </div>
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 14, textAlign: "center" }}>
              {formatGameTime(save.gameDay, save.gameTime)} · {save.director.keyItems.length}件物品
            </div>
            {save.checkpoint && (
              <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,160,80,0.6)", marginBottom: 12, textAlign: "center", padding: "6px 0", borderRadius: 6, background: "rgba(255,160,80,0.06)" }}>
                已有存档点，保存将覆盖
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setShowSaveConfirm(false)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 8,
                  border: `1px solid var(--c-adv-input-border)`, background: "transparent",
                  color: "var(--c-adv-text-dim)", fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  取消
                </button>
                <button onClick={() => {
                  // Inject current refs so checkpoint captures live state (save prop may be stale)
                  const { checkpoint: _, ...saveWithoutCheckpoint } = save;
                  const cpData = {
                    ...saveWithoutCheckpoint,
                    streamLog: streamRef.current.slice(-200),
                    pendingEvent: inEventRef.current ? {
                      inEvent: true,
                      choices: currentChoicesRef.current || undefined,
                      eventContext: eventContextRef.current || undefined,
                      eventMeta: activeEventMetaRef.current || undefined,
                      lastAction: lastFailedActionRef.current || undefined,
                      interruptedPhase: loadingPhaseRef.current || undefined,
                      completedCompanions: completedCompanionsRef.current.length > 0 ? completedCompanionsRef.current : undefined,
                    } : undefined,
                  };
                  const cp = JSON.stringify(cpData);
                  persistSave({ ...save, checkpoint: cp });
                  pushMessages({ id: mkId(), type: "system", text: "存档点已保存" });
                  setShowSaveConfirm(false);
                }} style={{
                  flex: 1, padding: "10px 0", borderRadius: 8,
                  border: "none", background: "var(--c-adv-accent-dim)",
                  color: "var(--c-adv-accent)", fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  保存
                </button>
              </div>
              {save.checkpoint && (
                <button onClick={() => {
                  try {
                    const cp = JSON.parse(save.checkpoint!) as GameSave;
                    // Restore UI state from checkpoint
                    setStreamMessages(cp.streamLog || []);
                    setInEvent(cp.pendingEvent?.inEvent || false);
                    setCurrentChoices(cp.pendingEvent?.choices || null);
                    setEventContext(cp.pendingEvent?.eventContext || "");
                    setActiveEventMeta(cp.pendingEvent?.eventMeta || null);
                    setActiveEvent(null);
                    setAccumulatedEvent(null);
                    setLastFailedAction(cp.pendingEvent?.lastAction || null);
                    setCompletedCompanions(cp.pendingEvent?.completedCompanions || []);
                    // Clear transient UI state
                    setLoadingPhase("");
                    setFreeText("");
                    setFreeAction("");
                    setLastFailedEvent(null);
                    // Save directly (bypass persistSave which would inject current refs)
                    const restored: GameSave = { ...cp, checkpoint: save.checkpoint };
                    saveGame(restored);
                    onSaveUpdate(restored);
                  } catch {
                    pushMessages({ id: mkId(), type: "system", text: "存档点损坏" });
                  }
                  setShowSaveConfirm(false);
                }} style={{
                  width: "100%", padding: "10px 0", borderRadius: 8,
                  border: "1px solid rgba(255,160,80,0.2)", background: "rgba(255,160,80,0.06)",
                  color: "rgba(255,160,80,0.7)", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  回到存档点
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Archive confirm */}
      {showArchiveConfirm && (
        <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => setShowArchiveConfirm(false)}>
          <div style={{
            background: "var(--c-adv-panel-bg)", borderRadius: 16,
            border: "1px solid var(--c-adv-accent-dim)",
            boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
            padding: "24px 20px", maxWidth: 300, width: "100%",
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: "calc(28px*var(--app-text-scale,1))", marginBottom: 8 }}>⚔️</div>
              <div style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 600, color: "var(--c-adv-text)", marginBottom: 4 }}>
                暂离冒险
              </div>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", lineHeight: 1.5 }}>
                {skeleton.world.name} · {formatGameTime(save.gameDay, save.gameTime)}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button onClick={() => { persistSave({ ...save, timestamp: new Date().toISOString() }); onBack(); }} style={{
                width: "100%", padding: "11px 0", borderRadius: 10,
                background: "var(--c-adv-accent-dim)", border: "none",
                color: "var(--c-adv-accent)", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500,
                cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em",
              }}>
                保存并离开
              </button>
              <button onClick={() => setShowArchiveConfirm(false)} style={{
                width: "100%", padding: "11px 0", borderRadius: 10,
                background: "transparent", border: "1px solid var(--c-adv-input-border)",
                color: "var(--c-adv-text-dim)", fontSize: "calc(13px*var(--app-text-scale,1))",
                cursor: "pointer", fontFamily: "inherit",
              }}>
                继续冒险
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Journal overlay */}
      {showJournal && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 30,
          background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 20,
        }} onClick={() => setShowJournal(false)}>
          <div style={{
            width: "100%", maxHeight: "70vh", overflow: "auto",
            background: "var(--c-adv-panel-bg)", borderRadius: 12,
            border: "1px solid var(--c-adv-input-border)", padding: 16,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", letterSpacing: "0.15em", color: "var(--c-adv-text-muted)", marginBottom: 12, fontFamily: "monospace" }}>
              冒险日志
            </div>
            {save.journal.slice().reverse().map(j => (
              <div key={j.id} style={{
                padding: "8px 0",
                borderBottom: "1px solid var(--c-adv-input-bg)",
                fontSize: "calc(12px*var(--app-text-scale,1))",
              }}>
                <div style={{ color: "var(--c-adv-accent-dim)", fontSize: "calc(10px*var(--app-text-scale,1))", marginBottom: 2 }}>
                  {j.timestamp} · {j.locationName}
                </div>
                <div style={{ color: "var(--c-adv-body)", lineHeight: 1.5 }}>{j.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
