import type { Component, JSX } from "solid-js"
import { createMemo, splitProps } from "solid-js"
import maas from "../assets/icons/provider/maas.png"
import sprite from "./provider-icons/sprite.svg"
import { iconNames, type IconName } from "./provider-icons/types"

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const resolved = createMemo(() => (iconNames.includes(local.id as IconName) ? local.id : "synthetic"))
  const classes = () => ({
    ...(local.classList ?? {}),
    [local.class ?? ""]: !!local.class,
  })

  if (local.id === "tatu-maas") {
    return (
      <svg data-component="provider-icon" {...rest} classList={classes()}>
        <image href={maas} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" />
      </svg>
    )
  }

  return (
    <svg
      data-component="provider-icon"
      {...rest}
      classList={classes()}
    >
      <use href={`${sprite}#${resolved()}`} />
    </svg>
  )
}
