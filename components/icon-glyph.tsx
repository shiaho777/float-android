import { memo } from "react";

import type { IconId } from "@/lib/desktop-config";
import {
  mdiCompass,
  mdiCubeOutline,
  mdiDice5,
  mdiFlower,
  mdiGhost,
  mdiHeart,
  mdiLeaf,
  mdiLightningBolt,
  mdiPuzzle,
  mdiRocketLaunch,
  mdiStar,
  mdiTeddyBear,
  mdiCogOutline,
  mdiMessageProcessing,
  mdiBookOpenPageVariant,
  mdiMusic,
  mdiBookOpenVariant,
  mdiFeather,
  mdiMovie,
  mdiGamepadVariant,
  mdiPackageVariant,
  mdiCellphone,
  mdiShopping,
  mdiCalendarMonth,
  mdiMicrophone,
  mdiScriptTextOutline,
  mdiMapMarker,
  mdiPlayCircle,
  mdiBookmark,
  mdiCamera,
  mdiAccountGroup,
  mdiPalette,
  mdiDatabase,
  mdiAccount,
  mdiHome,
  mdiBridge,
  mdiHammerWrench,
  mdiGlassCocktail,
  mdiStorefrontOutline,
  mdiMapMarkerRadius,
} from "@mdi/js";

type IconGlyphProps = {
  id: IconId;
  className?: string;
};

const MDI_PATHS: Record<IconId, string> = {
  settings: mdiCogOutline,
  chat: mdiMessageProcessing,
  diary: mdiBookOpenPageVariant,
  music: mdiMusic,
  reading: mdiBookOpenVariant,
  cocreate: mdiFeather,
  story: mdiMovie,
  game: mdiGamepadVariant,
  appmarket: mdiPackageVariant,
  xiaohongshu: mdiPackageVariant,
  checkphone: mdiCellphone,
  shopping: mdiShopping,
  calendar: mdiCalendarMonth,
  vnmode: mdiScriptTextOutline,
  resource_hub: mdiStorefrontOutline,
  vnplay: mdiPlayCircle,
  vnchapters: mdiBookmark,
  moments: mdiCamera,
  group_chat: mdiAccountGroup,
  theme: mdiPalette,
  resources: mdiDatabase,
  characters: mdiAccount,
};

function IconGlyphImpl({ id, className }: IconGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
    >
      <path
        d={MDI_PATHS[id] || "M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"}
        fill="var(--c-desktop-icon, #ffffff)"
        filter="drop-shadow(0 2px 4px rgba(0,0,0,0.1))"
      />
    </svg>
  );
}

// ===== 无图标自定义 APP 的兜底字形 =====
// 与内置图标同一套 mdi 风格,按名字哈希稳定选取,只有图形不同、配色跟随桌面主题。
const CUSTOM_APP_FALLBACK_PATHS = [
  mdiPuzzle,
  mdiHeart,
  mdiFlower,
  mdiRocketLaunch,
  mdiDice5,
  mdiCompass,
  mdiLightningBolt,
  mdiLeaf,
  mdiGhost,
  mdiStar,
  mdiCubeOutline,
  mdiTeddyBear,
];

export function customAppGlyphPath(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return CUSTOM_APP_FALLBACK_PATHS[hash % CUSTOM_APP_FALLBACK_PATHS.length];
}

function CustomAppGlyphImpl({ seed, className }: { seed: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        d={customAppGlyphPath(seed)}
        fill="var(--c-desktop-icon, #ffffff)"
        filter="drop-shadow(0 2px 4px rgba(0,0,0,0.1))"
      />
    </svg>
  );
}

// 桌面上每个图标都会渲染一次，父组件频繁重渲染时没必要跟着重画。
export const IconGlyph = memo(IconGlyphImpl);
export const CustomAppGlyph = memo(CustomAppGlyphImpl);
