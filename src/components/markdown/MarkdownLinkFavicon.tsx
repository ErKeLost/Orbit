import { Children, Fragment, useMemo, useState, type ReactNode } from "react";
import { isPrivateNetworkHost } from "../../lib/host-classification";
import { Globe } from "../../shared/ui/icons";

/**
 * 外部链接前面的站点图标。规则与 t3code 一致：
 *
 * - 先请求站点自己的 `/favicon.ico`（最快、最准），失败后才落到图标服务；
 * - 全都失败时退化成地球，而不是留一个空洞；
 * - 内网主机名不外发给图标服务，那等于把内网名字播到公网。
 *
 * "哪个来源成功过"按 host 记住：同一段回答里十条同站链接不该各自从"未知"
 * 开始重试；但一次失败不会被记住成永久结论，下一次仍从第一个来源试。
 */
const RESOLVED = new Map<string, number>();
const FAILED = new Set<string>();

function faviconSources(origin: string, host: string) {
  const brand = host.toLowerCase() === "github.com"
    ? ["https://github.githubassets.com/favicons/favicon.svg"]
    : [];
  return [
    ...brand,
    `${origin}/favicon.ico`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
  ];
}

function hostOf(href: string | undefined) {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.host || null;
  } catch {
    return null;
  }
}

export function LinkFavicon({ href }: { href: string | undefined }) {
  const host = hostOf(href);
  const origin = host ? `https://${host}` : "";
  const sources = useMemo(() => (host ? faviconSources(origin, host) : []), [host, origin]);
  const [index, setIndex] = useState(() => (host ? (RESOLVED.get(host) ?? 0) : 0));
  const [settled, setSettled] = useState<number | undefined>(() =>
    host ? RESOLVED.get(host) : undefined,
  );

  if (!host) return null;

  const privateHost = isPrivateNetworkHost(host.replace(/:\d+$/, ""));
  const failed = (host ? FAILED.has(host) : true) || privateHost;
  const src = sources[settled ?? index];

  return (
    <span className="md-link-icon" aria-hidden>
      {failed || !src ? (
        <Globe className="md-link-icon-image md-link-icon-fallback" />
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="md-link-icon-image"
          data-ready={settled === undefined ? undefined : ""}
          onLoad={() => {
            RESOLVED.set(host, index);
            setSettled(index);
          }}
          onError={() => {
            if (index + 1 < sources.length) {
              setIndex(index + 1);
              return;
            }
            FAILED.add(host);
            setSettled(undefined);
          }}
        />
      )}
    </span>
  );
}

function leadingSchemeLength(text: string) {
  const scheme = /^(?:https?:\/\/)/i.exec(text)?.[0];
  return scheme ? scheme.length : Math.min(text.length, 1);
}

function breakable(text: string) {
  return Array.from(text, (character, position) => (
    <Fragment key={`${position}:${character}`}>
      {character}
      <wbr />
    </Fragment>
  ));
}

/**
 * 图标与协议头一起不换行，剩下的字符才允许断行：长 URL 折行时，图标不会
 * 孤零零留在上一行末尾。
 */
export function ExternalLinkContent({
  href,
  plainText,
  children,
}: {
  href: string | undefined;
  plainText: string;
  children: ReactNode;
}) {
  if (plainText.trim().length === 0) return <>{children}</>;

  const leading = leadingSchemeLength(plainText);
  if (plainText.length <= leading) {
    return (
      <span className="md-link-nowrap">
        <LinkFavicon href={href} />
        {children}
      </span>
    );
  }
  return (
    <>
      <span className="md-link-nowrap">
        <LinkFavicon href={href} />
        {plainText.slice(0, leading)}
      </span>
      {breakable(plainText.slice(leading))}
    </>
  );
}

/** 链接里的纯文字：判断"是不是只有一张图"，也决定图标后面从哪里断行。 */
export function plainTextOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (Array.isArray(child)) return plainTextOf(child);
      if (child && typeof child === "object" && "props" in child) {
        const props = (child as { props?: { children?: ReactNode } }).props;
        return plainTextOf(props?.children ?? null);
      }
      return "";
    })
    .join("");
}
