import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <marker id="arr" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,1 L6,4 L0,7 Z" fill="var(--icon-strong-base)" />
        </marker>
      </defs>
      {/* Incoming fermion top */}
      <path d="M1,3 L4,7.5 L7,12" stroke="var(--icon-strong-base)" stroke-width="0.8" stroke-linecap="round" fill="none" marker-mid="url(#arr)" />
      {/* Incoming fermion bottom */}
      <path d="M1,21 L4,16.5 L7,12" stroke="var(--icon-strong-base)" stroke-width="0.8" stroke-linecap="round" fill="none" marker-mid="url(#arr)" />
      {/* Outgoing fermion top */}
      <path d="M17,12 L20,7.5 L23,3" stroke="var(--icon-strong-base)" stroke-width="0.8" stroke-linecap="round" fill="none" marker-mid="url(#arr)" />
      {/* Outgoing fermion bottom */}
      <path d="M17,12 L20,16.5 L23,21" stroke="var(--icon-strong-base)" stroke-width="0.8" stroke-linecap="round" fill="none" marker-mid="url(#arr)" />
      {/* Photon propagator — longer wavy line */}
      <path d="M7,12 Q8.5,9 10,12 Q11.5,15 13,12 Q14.5,9 16,12 Q16.8,13.5 17,12" stroke="var(--icon-strong-base)" stroke-width="0.8" stroke-linecap="round" fill="none" />
      {/* Vertices */}
      <circle cx="7" cy="12" r="1" fill="var(--icon-strong-base)" />
      <circle cx="17" cy="12" r="1" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <div
      classList={{ [props.class ?? ""]: !!props.class }}
      style="display: flex; flex-direction: column; align-items: center; gap: 0.5em; user-select: none;"
    >
      <div style="display: flex; align-items: baseline; gap: 0.6em; font-family: 'Courier New', Courier, monospace; letter-spacing: 0.2em; text-transform: uppercase; line-height: 1;">
        <span style="font-size: 2.25rem; font-weight: 700; color: var(--text-strong); text-shadow: 0 0 20px color-mix(in srgb, var(--text-strong) 60%, transparent), 0 0 40px color-mix(in srgb, var(--text-strong) 25%, transparent);">
          AETHER
        </span>
      </div>
      <div style="width: 100%; height: 1px; background: linear-gradient(to right, transparent, var(--text-base), transparent); opacity: 0.4;" />
    </div>
  )
}
