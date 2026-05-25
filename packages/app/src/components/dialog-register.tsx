import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useAuth } from "@/context/auth"
import { useLanguage } from "@/context/language"

function message(err: unknown, fallback: string, auth: string) {
  const code = (err as Error & { code?: string }).code
  if (code === "TIMEOUT" || code === "NETWORK_ERROR") return auth
  return (err as Error).message || fallback
}

export function DialogRegister() {
  const dialog = useDialog()
  const auth = useAuth()
  const language = useLanguage()

  const [form, setForm] = createStore({
    email: "",
    password: "",
    confirm: "",
    name: "",
    code: "",
    emailErr: undefined as string | undefined,
    passwordErr: undefined as string | undefined,
    confirmErr: undefined as string | undefined,
    nameErr: undefined as string | undefined,
    codeErr: undefined as string | undefined,
    submitting: false,
    sending: false,
    wait: 0,
    generalErr: undefined as string | undefined,
  })
  let timer: ReturnType<typeof setInterval> | undefined

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  function validEmail() {
    if (!form.email.trim()) {
      setForm("emailErr", language.t("auth.register.email.required"))
      return false
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setForm("emailErr", language.t("auth.register.email.invalid"))
      return false
    }
    return true
  }

  function validate(): boolean {
    let ok = true
    setForm({
      emailErr: undefined,
      passwordErr: undefined,
      confirmErr: undefined,
      nameErr: undefined,
      codeErr: undefined,
      generalErr: undefined,
    })

    if (!validEmail()) ok = false

    if (!form.password) {
      setForm("passwordErr", language.t("auth.register.password.required"))
      ok = false
    } else if (form.password.length < 8) {
      setForm("passwordErr", language.t("auth.register.password.tooShort"))
      ok = false
    } else if (!/[a-zA-Z]/.test(form.password) || !/[0-9]/.test(form.password)) {
      setForm("passwordErr", language.t("auth.register.password.weak"))
      ok = false
    }

    if (!form.confirm) {
      setForm("confirmErr", language.t("auth.register.confirm.required"))
      ok = false
    } else if (form.confirm !== form.password) {
      setForm("confirmErr", language.t("auth.register.confirm.mismatch"))
      ok = false
    }

    if (!form.name.trim()) {
      setForm("nameErr", language.t("auth.register.name.required"))
      ok = false
    } else if (form.name.trim().length > 100) {
      setForm("nameErr", language.t("auth.register.name.tooLong"))
      ok = false
    }

    if (!form.code.trim()) {
      setForm("codeErr", language.t("auth.register.code.required"))
      ok = false
    }

    return ok
  }

  function tick() {
    if (timer) clearInterval(timer)
    setForm("wait", 60)
    timer = setInterval(() => {
      setForm("wait", (wait) => {
        if (wait <= 1) {
          if (timer) clearInterval(timer)
          timer = undefined
          return 0
        }
        return wait - 1
      })
    }, 1000)
  }

  async function send() {
    setForm({ generalErr: undefined, emailErr: undefined })
    if (!validEmail() || form.sending || form.wait > 0) return
    setForm("sending", true)

    try {
      await auth.send(form.email.trim())
      tick()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("auth.register.code.sent.title"),
        description: language.t("auth.register.code.sent.description"),
      })
    } catch (err) {
      const code = (err as Error & { code?: string }).code
      if (code === "RATE_LIMITED" || code === "TOO_MANY_REQUESTS") {
        tick()
        setForm("generalErr", language.t("auth.register.error.rateLimited"))
        return
      }
      if (code === "ACCOUNT_ALREADY_EXISTS") {
        setForm("generalErr", language.t("auth.register.error.exists"))
        return
      }
      setForm("generalErr", message(err, language.t("common.requestFailed"), language.t("auth.error.unreachable")))
    } finally {
      setForm("sending", false)
    }
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (!validate()) return
    setForm("submitting", true)

    try {
      await auth.register(form.email.trim(), form.password, form.name.trim(), form.code.trim())
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("auth.register.success.title"),
        description: language.t("auth.register.success.description"),
      })
    } catch (err) {
      const code = (err as Error & { code?: string }).code
      if (code === "ACCOUNT_ALREADY_EXISTS") {
        setForm("generalErr", language.t("auth.register.error.exists"))
      } else if (code === "INVALID_VERIFICATION_CODE" || code === "VERIFICATION_CODE_EXPIRED") {
        setForm("codeErr", language.t("auth.register.code.invalid"))
      } else if (code === "WEAK_PASSWORD") {
        setForm("passwordErr", language.t("auth.register.password.weak"))
      } else if (code === "RATE_LIMITED" || code === "TOO_MANY_REQUESTS") {
        setForm("generalErr", language.t("auth.register.error.rateLimited"))
      } else if (code === "INVALID_PARAMETER") {
        setForm("generalErr", language.t("auth.register.error.invalidParam"))
      } else {
        setForm("generalErr", message(err, language.t("common.requestFailed"), language.t("auth.error.unreachable")))
      }
    } finally {
      setForm("submitting", false)
    }
  }

  return (
    <Dialog title={language.t("auth.register.title")} fit>
      <form onSubmit={handleSubmit} class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <TextField
          autofocus
          type="email"
          label={language.t("auth.register.email.label")}
          placeholder={language.t("auth.register.email.placeholder")}
          value={form.email}
          onChange={(v) => {
            setForm("email", v)
            setForm("emailErr", undefined)
            setForm("generalErr", undefined)
          }}
          validationState={form.emailErr ? "invalid" : undefined}
          error={form.emailErr}
        />
        <div class="flex items-end gap-2">
          <TextField
            type="text"
            label={language.t("auth.register.code.label")}
            placeholder={language.t("auth.register.code.placeholder")}
            value={form.code}
            onChange={(v) => {
              setForm("code", v)
              setForm("codeErr", undefined)
              setForm("generalErr", undefined)
            }}
            validationState={form.codeErr ? "invalid" : undefined}
            error={form.codeErr}
            class="min-w-0"
          />
          <Button
            type="button"
            variant="secondary"
            size="large"
            class="shrink-0"
            disabled={form.sending || form.wait > 0}
            onClick={send}
          >
            {form.wait > 0
              ? language.t("auth.register.code.resend", { seconds: form.wait })
              : form.sending
                ? language.t("auth.register.code.sending")
                : language.t("auth.register.code.send")}
          </Button>
        </div>
        <TextField
          type="password"
          label={language.t("auth.register.password.label")}
          placeholder={language.t("auth.register.password.placeholder")}
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
          label={language.t("auth.register.confirm.label")}
          placeholder={language.t("auth.register.confirm.placeholder")}
          value={form.confirm}
          onChange={(v) => {
            setForm("confirm", v)
            setForm("confirmErr", undefined)
            setForm("generalErr", undefined)
          }}
          validationState={form.confirmErr ? "invalid" : undefined}
          error={form.confirmErr}
        />
        <TextField
          type="text"
          label={language.t("auth.register.name.label")}
          placeholder={language.t("auth.register.name.placeholder")}
          value={form.name}
          onChange={(v) => {
            setForm("name", v)
            setForm("nameErr", undefined)
            setForm("generalErr", undefined)
          }}
          validationState={form.nameErr ? "invalid" : undefined}
          error={form.nameErr}
        />
        {form.generalErr && <div class="text-14-regular text-text-critical">{form.generalErr}</div>}
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" type="submit" disabled={form.submitting}>
            {form.submitting ? language.t("auth.register.submitting") : language.t("auth.register.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
