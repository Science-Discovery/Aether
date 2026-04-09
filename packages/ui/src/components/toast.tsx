/** @jsxImportSource solid-js */
import { Toast as Kobalte, toaster } from "@kobalte/core/toast"
import type { ToastRootProps, ToastCloseButtonProps, ToastTitleProps, ToastDescriptionProps } from "@kobalte/core/toast"
import type { ComponentProps, JSX } from "solid-js"
import { Show } from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"
import { Icon, type IconProps } from "./icon"
import { IconButton } from "./icon-button"

export interface ToastRegionProps extends ComponentProps<typeof Kobalte.Region> {}

function ToastRegion(props: ToastRegionProps) {
  return (
    <Portal>
      <Kobalte.Region data-component="toast-region" {...props}>
        <Kobalte.List data-slot="toast-list" />
      </Kobalte.Region>
    </Portal>
  )
}

export interface ToastRootComponentProps extends ToastRootProps {
  class?: string
  classList?: ComponentProps<"li">["classList"]
  children?: JSX.Element
}

function ToastRoot(props: ToastRootComponentProps) {
  return (
    <Kobalte
      data-component="toast"
      classList={{
        ...(props.classList ?? {}),
        [props.class ?? ""]: !!props.class,
      }}
      {...props}
    />
  )
}

function ToastIcon(props: { name: IconProps["name"] }) {
  return (
    <div data-slot="toast-icon">
      <Icon name={props.name} />
    </div>
  )
}

function ToastContent(props: ComponentProps<"div">) {
  return <div data-slot="toast-content" {...props} />
}

function ToastTitle(props: ToastTitleProps & ComponentProps<"div">) {
  return <Kobalte.Title data-slot="toast-title" {...props} />
}

function ToastDescription(props: ToastDescriptionProps & ComponentProps<"div">) {
  return <Kobalte.Description data-slot="toast-description" {...props} />
}

function ToastActions(props: ComponentProps<"div">) {
  return <div data-slot="toast-actions" {...props} />
}

function ToastCloseButton(props: ToastCloseButtonProps & ComponentProps<"button">) {
  const i18n = useI18n()
  return (
    <Kobalte.CloseButton
      data-slot="toast-close-button"
      as={IconButton}
      icon="close"
      variant="ghost"
      aria-label={i18n.t("ui.common.dismiss")}
      {...props}
    />
  )
}

function ToastProgressTrack(props: ComponentProps<typeof Kobalte.ProgressTrack>) {
  return <Kobalte.ProgressTrack data-slot="toast-progress-track" {...props} />
}

function ToastProgressFill(props: ComponentProps<typeof Kobalte.ProgressFill>) {
  return <Kobalte.ProgressFill data-slot="toast-progress-fill" {...props} />
}

export const Toast = Object.assign(ToastRoot, {
  Region: ToastRegion,
  Icon: ToastIcon,
  Content: ToastContent,
  Title: ToastTitle,
  Description: ToastDescription,
  Actions: ToastActions,
  CloseButton: ToastCloseButton,
  ProgressTrack: ToastProgressTrack,
  ProgressFill: ToastProgressFill,
})

export { toaster }

export type ToastVariant = "default" | "success" | "error" | "loading"

export interface ToastAction {
  label: string
  onClick:
    | "dismiss"
    | ((input: { toastId: number; placement?: ToastOptions["placement"]; offset: { x: number; y: number } }) =>
        | void
        | Promise<void>)
}

export interface ToastOptions {
  title?: string
  description?: string
  icon?: IconProps["name"]
  variant?: ToastVariant
  duration?: number
  persistent?: boolean
  placement?: "bottom-right" | "top-center"
  guarded?: boolean
  offset?: { x: number; y: number }
  actions?: ToastAction[]
}

type Context = {
  placement?: ToastOptions["placement"]
  offset: { x: number; y: number }
}

let current: Context | undefined

function region(placement: ToastOptions["placement"]) {
  return placement === "top-center" ? "top-center" : "bottom-right"
}

function shift(input: { placement?: ToastOptions["placement"]; x: number; y: number }) {
  return `translate(${input.x}px, ${input.y}px)`
}

function ToastItem(props: { toastId: number; opts: ToastOptions }) {
  const [drag, setDrag] = createStore({
    x: props.opts.offset?.x ?? 0,
    y: props.opts.offset?.y ?? 0,
    on: false,
    px: 0,
    py: 0,
    id: -1,
  })

  const stop = (event: Event) => event.preventDefault()
  const draggable = props.opts.guarded && props.opts.placement === "top-center"

  const down: JSX.EventHandlerUnion<HTMLElement, PointerEvent> = (event) => {
    if (!draggable) return
    const node = event.target as HTMLElement | null
    if (node?.closest("[data-slot='toast-action']")) return
    setDrag({
      on: true,
      px: event.clientX,
      py: event.clientY,
      id: event.pointerId,
    })
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }

  const move: JSX.EventHandlerUnion<HTMLElement, PointerEvent> = (event) => {
    if (!drag.on) return
    if (event.pointerId !== drag.id) return
    setDrag({
      x: drag.x + event.clientX - drag.px,
      y: drag.y + event.clientY - drag.py,
      px: event.clientX,
      py: event.clientY,
    })
    event.preventDefault()
    event.stopPropagation()
  }

  const up: JSX.EventHandlerUnion<HTMLElement, PointerEvent> = (event) => {
    if (!drag.on) return
    if (event.pointerId !== drag.id) return
    setDrag({ on: false, id: -1 })
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <Toast
      toastId={props.toastId}
      duration={props.opts.duration}
      persistent={props.opts.persistent}
      onEscapeKeyDown={props.opts.guarded ? stop : undefined}
      onSwipeStart={props.opts.guarded ? stop : undefined}
      onSwipeMove={props.opts.guarded ? stop : undefined}
      onSwipeCancel={props.opts.guarded ? stop : undefined}
      onSwipeEnd={props.opts.guarded ? stop : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      data-variant={props.opts.variant ?? "default"}
      data-placement={props.opts.placement ?? "bottom-right"}
      data-draggable={draggable ? "true" : undefined}
      data-dragging={drag.on ? "true" : undefined}
      data-shifted={drag.x !== 0 || drag.y !== 0 ? "true" : undefined}
      style={{ transform: shift({ placement: props.opts.placement, x: drag.x, y: drag.y }) }}
    >
      <Show when={props.opts.icon}>
        <Toast.Icon name={props.opts.icon!} />
      </Show>
      <Toast.Content>
        <Show when={props.opts.title}>
          <Toast.Title>{props.opts.title}</Toast.Title>
        </Show>
        <Show when={props.opts.description}>
          <Toast.Description>{props.opts.description}</Toast.Description>
        </Show>
        <Show when={props.opts.actions?.length}>
          <Toast.Actions>
            {props.opts.actions!.map((action) => (
              <button
                data-slot="toast-action"
                onClick={() => {
                  current = {
                    placement: props.opts.placement,
                    offset: { x: drag.x, y: drag.y },
                  }
                  if (typeof action.onClick === "function") {
                    const result = action.onClick({
                      toastId: props.toastId,
                      placement: props.opts.placement,
                      offset: { x: drag.x, y: drag.y },
                    })
                    if (result && typeof (result as Promise<unknown>).finally === "function") {
                      ;(result as Promise<unknown>).finally(() => {
                        current = undefined
                      })
                    } else {
                      current = undefined
                    }
                  } else {
                    current = undefined
                  }
                  toaster.dismiss(props.toastId)
                }}
              >
                {action.label}
              </button>
            ))}
          </Toast.Actions>
        </Show>
      </Toast.Content>
      <Show when={!props.opts.guarded}>
        <Toast.CloseButton />
      </Show>
    </Toast>
  )
}

export function showToast(options: ToastOptions | string) {
  const raw = typeof options === "string" ? { description: options } : options
  const opts =
    raw.offset || !current || raw.placement !== current.placement
      ? raw
      : {
          ...raw,
          offset: current.offset,
        }
  return toaster.show((props) => <ToastItem toastId={props.toastId} opts={opts} />, {
    region: region(opts.placement),
  })
}

export interface ToastPromiseOptions<T, U = unknown> {
  loading?: JSX.Element
  success?: (data: T) => JSX.Element
  error?: (error: U) => JSX.Element
}

export function showPromiseToast<T, U = unknown>(
  promise: Promise<T> | (() => Promise<T>),
  options: ToastPromiseOptions<T, U>,
) {
  return toaster.promise(promise, (props) => (
    <Toast
      toastId={props.toastId}
      data-variant={props.state === "pending" ? "loading" : props.state === "fulfilled" ? "success" : "error"}
    >
      <Toast.Content>
        <Toast.Description>
          {props.state === "pending" && options.loading}
          {props.state === "fulfilled" && options.success?.(props.data!)}
          {props.state === "rejected" && options.error?.(props.error)}
        </Toast.Description>
      </Toast.Content>
      <Toast.CloseButton />
    </Toast>
  ))
}
