type Pick = {
  path: string | null
  unavailable?: boolean
  reason?: "missing_picker" | string
}

type Toast = (input: {
  variant: "error"
  title: string
  description: string
}) => unknown

export function picked(input: Pick | undefined, toast: Toast, title: string) {
  const path = input?.path?.trim()
  if (path) return path
  if (!input?.unavailable) return

  toast({
    variant: "error",
    title,
    description:
      input.reason === "missing_picker"
        ? "This server cannot open a folder picker here. Enter the path manually or install zenity/kdialog."
        : "This server cannot open a folder picker here. Enter the path manually.",
  })
}
