import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createStore } from "solid-js/store"
import { useAuth } from "@/context/auth"
import { useLanguage } from "@/context/language"
import { message, scrub } from "@/utils/auth"

type View = "login" | "forgot" | "reset"

export function DialogLogin() {
  const dialog = useDialog()
  const auth = useAuth()
  const language = useLanguage()
  const params = new URLSearchParams(location.search)
  const reset = params.get("reset_token") ?? ""
  const [state, setState] = createStore({
    hover: false,
  })
  let run = 0

  const [form, setForm] = createStore({
    view: reset ? ("reset" as View) : ("login" as View),
    email: "",
    password: "",
    confirm: "",
    token: reset,
    emailErr: undefined as string | undefined,
    passwordErr: undefined as string | undefined,
    confirmErr: undefined as string | undefined,
    tokenErr: undefined as string | undefined,
    submitting: false,
    generalErr: undefined as string | undefined,
    sent: false,
  })

  function requireEmail(): boolean {
    if (!form.email.trim()) {
      setForm("emailErr", language.t("auth.login.email.required"))
      return false
    }
    return true
  }

  function validateLogin(): boolean {
    let ok = true
    setForm({ emailErr: undefined, passwordErr: undefined, generalErr: undefined })

    if (!requireEmail()) ok = false

    if (!form.password) {
      setForm("passwordErr", language.t("auth.login.password.required"))
      ok = false
    }

    return ok
  }

  function validateReset(): boolean {
    let ok = true
    setForm({
      passwordErr: undefined,
      confirmErr: undefined,
      tokenErr: undefined,
      generalErr: undefined,
    })

    if (!form.token.trim()) {
      setForm("tokenErr", language.t("auth.reset.token.required"))
      ok = false
    }

    if (!form.password) {
      setForm("passwordErr", language.t("auth.reset.password.required"))
      ok = false
    } else if (form.password.length < 8) {
      setForm("passwordErr", language.t("auth.reset.password.tooShort"))
      ok = false
    } else if (!/[a-zA-Z]/.test(form.password) || !/[0-9]/.test(form.password)) {
      setForm("passwordErr", language.t("auth.reset.password.weak"))
      ok = false
    }

    if (!form.confirm) {
      setForm("confirmErr", language.t("auth.reset.confirm.required"))
      ok = false
    } else if (form.confirm !== form.password) {
      setForm("confirmErr", language.t("auth.reset.confirm.mismatch"))
      ok = false
    }

    return ok
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (!validateLogin()) return
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
        setForm("generalErr", message(err, language.t("common.requestFailed"), language.t("auth.error.unreachable")))
      }
    } finally {
      setForm("submitting", false)
    }
  }

  async function handleForgot(e: SubmitEvent) {
    e.preventDefault()
    setForm({ emailErr: undefined, generalErr: undefined, sent: false })
    if (!requireEmail()) return
    setForm("submitting", true)

    try {
      await auth.forgot(form.email.trim())
      setForm("sent", true)
    } catch (err) {
      const code = (err as Error & { code?: string }).code
      if (code === "RATE_LIMITED" || code === "TOO_MANY_REQUESTS") {
        setForm("generalErr", language.t("auth.login.error.rateLimited"))
        return
      }
      setForm("generalErr", message(err, language.t("common.requestFailed"), language.t("auth.error.unreachable")))
    } finally {
      setForm("submitting", false)
    }
  }

  async function handleReset(e: SubmitEvent) {
    e.preventDefault()
    if (!validateReset()) return
    setForm("submitting", true)

    try {
      await auth.reset(form.token.trim(), form.password)
      scrub()
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("auth.reset.success.title"),
        description: language.t("auth.reset.success.description"),
      })
    } catch (err) {
      const code = (err as Error & { code?: string }).code
      if (code === "INVALID_RESET_TOKEN" || code === "RESET_TOKEN_EXPIRED") {
        setForm("tokenErr", language.t("auth.reset.token.invalid"))
        return
      }
      if (code === "WEAK_PASSWORD") {
        setForm("passwordErr", language.t("auth.reset.password.weak"))
        return
      }
      setForm("generalErr", message(err, language.t("common.requestFailed"), language.t("auth.error.unreachable")))
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

  function open(view: View) {
    setForm({
      view,
      password: "",
      confirm: "",
      emailErr: undefined,
      passwordErr: undefined,
      confirmErr: undefined,
      tokenErr: undefined,
      generalErr: undefined,
      sent: false,
    })
  }

  const title = () => {
    if (form.view === "forgot") return language.t("auth.forgot.title")
    if (form.view === "reset") return language.t("auth.reset.title")
    return language.t("auth.login.title")
  }

  return (
    <Dialog title={title()} fit>
      {form.view === "login" && (
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
          <button
            type="button"
            class="text-12-medium text-text-link self-end transition-opacity duration-150 hover:opacity-80"
            onClick={() => open("forgot")}
          >
            {language.t("auth.login.forgotPassword")}
          </button>
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
      )}
      {form.view === "forgot" && (
        <form onSubmit={handleForgot} class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
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
              setForm("sent", false)
            }}
            validationState={form.emailErr ? "invalid" : undefined}
            error={form.emailErr}
          />
          {form.sent && <div class="text-14-regular text-text-success">{language.t("auth.forgot.success")}</div>}
          {form.generalErr && <div class="text-14-regular text-text-critical">{form.generalErr}</div>}
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="large" type="button" onClick={() => open("login")}>
              {language.t("common.goBack")}
            </Button>
            <Button variant="primary" size="large" type="submit" disabled={form.submitting}>
              {form.submitting ? language.t("auth.forgot.submitting") : language.t("auth.forgot.submit")}
            </Button>
          </div>
        </form>
      )}
      {form.view === "reset" && (
        <form onSubmit={handleReset} class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <TextField
            autofocus={!form.token}
            type="text"
            label={language.t("auth.reset.token.label")}
            placeholder={language.t("auth.reset.token.placeholder")}
            value={form.token}
            onChange={(v) => {
              setForm("token", v)
              setForm("tokenErr", undefined)
              setForm("generalErr", undefined)
            }}
            validationState={form.tokenErr ? "invalid" : undefined}
            error={form.tokenErr}
          />
          <TextField
            autofocus={!!form.token}
            type="password"
            label={language.t("auth.reset.password.label")}
            placeholder={language.t("auth.reset.password.placeholder")}
            value={form.password}
            onChange={(v) => {
              setForm("password", v)
              setForm("passwordErr", undefined)
              setForm("confirmErr", undefined)
              setForm("generalErr", undefined)
            }}
            validationState={form.passwordErr ? "invalid" : undefined}
            error={form.passwordErr}
          />
          <TextField
            type="password"
            label={language.t("auth.reset.confirm.label")}
            placeholder={language.t("auth.reset.confirm.placeholder")}
            value={form.confirm}
            onChange={(v) => {
              setForm("confirm", v)
              setForm("confirmErr", undefined)
              setForm("generalErr", undefined)
            }}
            validationState={form.confirmErr ? "invalid" : undefined}
            error={form.confirmErr}
          />
          {form.generalErr && <div class="text-14-regular text-text-critical">{form.generalErr}</div>}
          <div class="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="large" type="button" onClick={() => open("login")}>
              {language.t("common.goBack")}
            </Button>
            <Button variant="primary" size="large" type="submit" disabled={form.submitting}>
              {form.submitting ? language.t("auth.reset.submitting") : language.t("auth.reset.submit")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
