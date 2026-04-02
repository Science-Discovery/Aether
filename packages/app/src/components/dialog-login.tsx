import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createStore } from "solid-js/store"
import { useAuth } from "@/context/auth"
import { useLanguage } from "@/context/language"

export function DialogLogin() {
  const dialog = useDialog()
  const auth = useAuth()
  const language = useLanguage()
  const [state, setState] = createStore({
    hover: false,
  })
  let run = 0

  const [form, setForm] = createStore({
    email: "",
    password: "",
    emailErr: undefined as string | undefined,
    passwordErr: undefined as string | undefined,
    submitting: false,
    generalErr: undefined as string | undefined,
  })

  function validate(): boolean {
    let ok = true
    setForm({ emailErr: undefined, passwordErr: undefined, generalErr: undefined })

    if (!form.email.trim()) {
      setForm("emailErr", language.t("auth.login.email.required"))
      ok = false
    }

    if (!form.password) {
      setForm("passwordErr", language.t("auth.login.password.required"))
      ok = false
    }

    return ok
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (!validate()) return
    setForm("submitting", true)

    try {
      await auth.login(form.email.trim(), form.password)
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("auth.login.success.title"),
        description: language.t("auth.login.success.description"),
      })
    } catch (err) {
      const code = (err as Error & { code?: string }).code
      if (code === "INVALID_CREDENTIALS") {
        setForm("generalErr", language.t("auth.login.error.invalidCredentials"))
      } else if (code === "RATE_LIMITED") {
        setForm("generalErr", language.t("auth.login.error.rateLimited"))
      } else if (code === "INVALID_PARAMETER") {
        setForm("generalErr", language.t("auth.register.error.invalidParam"))
      } else {
        setForm("generalErr", (err as Error).message || language.t("common.requestFailed"))
      }
    } finally {
      setForm("submitting", false)
    }
  }

  function openRegister() {
    const id = ++run
    void import("@/components/dialog-register").then((x) => {
      if (run !== id) return
      dialog.show(() => <x.DialogRegister />)
    })
  }

  return (
    <Dialog title={language.t("auth.login.title")} fit>
      <form onSubmit={handleSubmit} class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <TextField
          autofocus
          type="email"
          label={language.t("auth.login.email.label")}
          placeholder={language.t("auth.login.email.placeholder")}
          value={form.email}
          onChange={(v) => {
            setForm("email", v)
            setForm("emailErr", undefined)
            setForm("generalErr", undefined)
          }}
          validationState={form.emailErr ? "invalid" : undefined}
          error={form.emailErr}
        />
        <TextField
          type="password"
          label={language.t("auth.login.password.label")}
          placeholder={language.t("auth.login.password.placeholder")}
          value={form.password}
          onChange={(v) => {
            setForm("password", v)
            setForm("passwordErr", undefined)
            setForm("generalErr", undefined)
          }}
          validationState={form.passwordErr ? "invalid" : undefined}
          error={form.passwordErr}
        />
        {form.generalErr && <div class="text-14-regular text-text-critical">{form.generalErr}</div>}
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" type="submit" disabled={form.submitting}>
            {form.submitting ? language.t("auth.login.submitting") : language.t("auth.login.submit")}
          </Button>
        </div>
        <button
          type="button"
          class="text-12-medium text-text-link self-end transition-all duration-150 hover:opacity-80 hover:-translate-y-0.5"
          onMouseEnter={() => setState("hover", true)}
          onMouseLeave={() => setState("hover", false)}
          onClick={openRegister}
        >
          {state.hover ? language.t("auth.login.newUserRegisterHover") : language.t("auth.login.newUserRegister")}
        </button>
      </form>
    </Dialog>
  )
}
