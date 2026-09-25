/** One safe channel resolver and one icon row for the public V2 footer and the
 * inert Admin draft sample. Content is shared WebsiteSettings, never V2-only. */
import { useI18n } from "@/lib/i18n/I18nProvider";
import { dictionaries, type Language } from "@/lib/i18n/dictionary";
import type { SocialPlatform, WebsiteSettings } from "../types";
import { resolvedSocialLinks } from "../services/settingsDefaults";
import { socialChannelHref } from "../services/socialSafety";
import { SocialIcon } from "../components/storefront/SocialIcon";

export type V2SocialChannel = { platform: SocialPlatform; href: string; label: string };
const ORDER: SocialPlatform[] = ["facebook", "instagram", "tiktok", "whatsapp"];

/** Always use the shared resolver so a legacy URL, an explicitly disabled row,
 * and an owner-edited bilingual WhatsApp message behave identically in preview
 * and on a fresh public route. Malformed stored rows fail closed. */
export function resolvedV2SocialChannels(settings: WebsiteSettings, language: Language): V2SocialChannel[] {
  const rows = new Map(resolvedSocialLinks(settings).map((row) => [row.platform, row]));
  return ORDER.flatMap((platform) => {
    const row = rows.get(platform);
    if (!row?.enabled) return [];
    const message = platform === "whatsapp"
      ? (language === "ar" ? row.message_ar || row.message_en : row.message_en || row.message_ar) ?? "" : "";
    const href = socialChannelHref(platform, row.url, message);
    if (!href) return [];
    const name = dictionaries[language][`online.settings.${platform}`];
    const custom = (language === "ar" ? row.label_ar || row.label_en : row.label_en || row.label_ar).trim();
    const label = custom && custom.toLowerCase() !== name.toLowerCase() ? `${name} — ${custom}` : name;
    return [{ platform, href, label }];
  });
}

export function V2SocialIcons({ channels, inert = false }: { channels: V2SocialChannel[]; inert?: boolean }) {
  const { t } = useI18n();
  if (!channels.length) return null;
  return <div className="v2-footer-social" role="group" aria-label={t("store.social.followUs")}
    data-testid="v2-social-icons">
    {channels.map((channel) => inert
      ? <span key={channel.platform} className="v2-social-icon" data-platform={channel.platform}>
          <SocialIcon kind={channel.platform} />
        </span>
      : <a key={channel.platform} className="v2-social-icon" data-platform={channel.platform}
          href={channel.href} target="_blank" rel="noopener noreferrer"
          title={channel.label} aria-label={`${channel.label} ${t("common.opensInNewTab")}`}>
          <SocialIcon kind={channel.platform} />
        </a>)}
  </div>;
}
