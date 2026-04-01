import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createStore } from "solid-js/store"
import { useAuth } from "@/context/auth"
import { useLanguage } from "@/context/language"

export function DialogRegister() {
  const dialog = useDialog()
  const auth = useAuth()
  const language = useLanguage()

  const [form, setForm] = createStore({
    email: "",
    password: "",
    name: "",
    emailErr: undefined as string | undefined,
    passwordErr: undefined as string | undefined,
    nameErr: undefined as string | undefined,
    submitting: false,
    generalErr: undefined as string | undefined,
  })

  function validate(): boolean {
    let ok = true
    setForm({ emailErr: undefined, passwordErr: undefined, nameErr: undefined, generalErr: undefined })

    if (!form.email.trim()) {
      setForm("emailErr", language.t("auth.register.email.required"))
      ok = false
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setForm("emailErr", language.t("auth.register.email.invalid"))
      ok = false
    }

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

    if (!form.name.trim()) {
      setForm("nameErr", language.t("auth.register.name.required"))
      ok = false
    } else if (form.name.trim().length > 100) {
      setForm("nameErr", language.t("auth.register.name.tooLong"))
      ok = false
    }

    return ok
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (!validate()) return
    setForm("submitting", true)

    try {
      await auth.register(form.email.trim(), form.password, form.name.trim())
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
      } else if (code === "WEAK_PASSWORD") {
        setForm("passwordErr", language.t("auth.register.password.weak"))
      } else if (code === "INVALID_PARAMETER") {
        setForm("generalErr", language.t("auth.register.error.invalidParam"))
      } else {
        setForm("generalErr", (err as Error).message || language.t("common.requestFailed"))
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
          onChange={(v) => { setForm("email", v); setForm("emailErr", undefined); setForm("generalErr", undefined) }}
          validationState={form.emailErr ? "invalid" : undefined}
          error={form.emailErr}
        />
        <TextField
          type="password"
          label={language.t("auth.register.password.label")}
          placeholder={language.t("auth.register.password.placeholder")}
          value={form.password}
          onChange={(v) => { setForm("password", v); setForm("passwordErr", undefined); setForm("generalErr", undefined) }}
          validationState={form.passwordErr ? "invalid" : undefined}
          error={form.passwordErr}
        />
        <TextField
          type="text"
          label={language.t("auth.register.name.label")}
          placeholder={language.t("auth.register.name.placeholder")}
          value={form.name}
          onChange={(v) => { setForm("name", v); setForm("nameErr", undefined); setForm("generalErr", undefined) }}
          validationState={form.nameErr ? "invalid" : undefined}
          error={form.nameErr}
        />
        {form.generalErr && (
          <div class="text-14-regular text-text-critical">{form.generalErr}</div>
        )}
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