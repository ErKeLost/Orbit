import type { SVGProps } from 'react'

/**
 * Inline icons at one weight, drawn for this page.
 *
 * Eight paths are cheaper than a dependency, and no icon set matches the app's
 * 1.5px stroke on a 24px grid. Brand marks (Apple, Windows, GitHub) keep their
 * own silhouettes — redrawing a logo is how it stops being a logo.
 */

type IconProps = SVGProps<SVGSVGElement>

const stroke = (props: IconProps) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...props,
})

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...stroke(props)}>
      <path d="M12 3.5v10.2m0 0 3.8-3.8M12 13.7 8.2 9.9M4.5 16.4v1.4a2.2 2.2 0 0 0 2.2 2.2h10.6a2.2 2.2 0 0 0 2.2-2.2v-1.4" />
    </svg>
  )
}

export function StarIcon(props: IconProps) {
  return (
    <svg {...stroke(props)}>
      <path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8z" />
    </svg>
  )
}




/** Apple's own silhouette. */
export function AppleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M16.6 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.5-.2-2.8.8-3.6.8-.7 0-1.9-.8-3.1-.8-1.6 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.3 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.2.9-1.2 1.3-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.8ZM14.3 5.8c.6-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.4-.6.7-1.1 1.9-1 2.9 1.1.1 2.2-.5 2.8-1.3Z" />
    </svg>
  )
}

/** Windows' four panes. */
export function WindowsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M4 5.6l7.1-1v6.9H4V5.6Zm8.3-1.2L20 3.2v8.3h-7.7V4.4ZM4 13.2h7.1v6.9L4 19.1v-5.9Zm8.3 0H20v8.3l-7.7-1.1v-7.2Z" />
    </svg>
  )
}

/**
 * Linux: Tux, as a silhouette. A filled shape is what reads at 14px — an outline
 * penguin turns into a smudge. The eyes are punched out with `evenodd` so the
 * mark still has a face at 2×.
 */
export function LinuxIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 1.9c-2.15 0-3.6 1.8-3.6 4.05 0 1.02-.24 1.7-.86 2.55C6.2 10.2 4.9 12.05 4.9 14.1c0 1.5.76 2.5 2 3.05-.14.4-.3.66-.5.9-.34.4-.2.95.34 1.05l1.6.3c.7.13 1.35-.2 1.6-.8.22-.52.5-.9.86-1.15.8.14 1.6.2 2.4.2s1.6-.06 2.4-.2c.36.25.64.63.86 1.15.25.6.9.93 1.6.8l1.6-.3c.54-.1.68-.65.34-1.05-.2-.24-.36-.5-.5-.9 1.24-.55 2-1.55 2-3.05 0-2.05-1.3-3.9-2.64-5.6-.62-.85-.86-1.53-.86-2.55C15.6 3.7 14.15 1.9 12 1.9Zm-1.5 3.3a.72.72 0 1 0 0 1.44.72.72 0 0 0 0-1.44Zm3 0a.72.72 0 1 0 0 1.44.72.72 0 0 0 0-1.44Z"
      />
    </svg>
  )
}

/** Intel: the processor, not the wordmark — at this size a logo lockup is a blur. */
export function ChipIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 3.2h1.5V5H9V3.2Zm4.5 0H15V5h-1.5V3.2ZM9 19h1.5v1.8H9V19Zm4.5 0H15v1.8h-1.5V19ZM3.2 9v1.5H5V9H3.2Zm0 4.5V15H5v-1.5H3.2ZM19 9v1.5h1.8V9H19Zm0 4.5V15h1.8v-1.5H19ZM7 7h10v10H7V7Zm2 2v6h6V9H9Z"
      />
    </svg>
  )
}

export function GitHubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
