import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js"
import { base64Encode } from "@opencode-ai/util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { decode64 } from "@/utils/base64"
import { toolcall } from "@/utils/model-capabilities"
import { formatServerError } from "@/utils/server-errors"
import { watchMineruMonitor } from "./mineru-monitor"

type Option = {
  providerID: string
  modelID: string
  label: string
}

const commands = {
  check: "py --list",
  python: "winget install --id Python.Python.3.12 --exact",
  env: 'py -3.12 -m venv "$env:USERPROFILE\\mineru-env"',
  uv: '& "$env:USERPROFILE\\mineru-env\\Scripts\\python.exe" -m pip install -U pip uv',
  mineru:
    '& "$env:USERPROFILE\\mineru-env\\Scripts\\uv.exe" pip install --python "$env:USERPROFILE\\mineru-env\\Scripts\\python.exe" -U "mineru[all]"',
  start: [
    '$env:MINERU_MODEL_SOURCE="modelscope"',
    '& "$env:USERPROFILE\\mineru-env\\Scripts\\mineru-api.exe" --host 127.0.0.1 --port 8000',
  ].join("\n"),
  connect: "http://127.0.0.1:8000",
}

const Step: Component<{ index: number; title: string; description: string; value: string; action: string }> = (props) => (
  <li class="grid grid-cols-[28px_minmax(0,1fr)] gap-3 border-b border-border-weak-base pb-4 last:border-b-0 last:pb-0">
    <span class="flex size-7 items-center justify-center rounded-full bg-surface-raised-base text-12-medium text-text-strong">
      {props.index}
    </span>
    <div class="min-w-0">
      <p class="text-13-medium text-text-strong">{props.title}</p>
      <p class="mb-2 mt-0.5 text-12-regular leading-5 text-text-weak">{props.description}</p>
      <TextField
        data-action={props.action}
        label={props.title}
        value={props.value}
        class="font-mono text-11-regular leading-5"
        readOnly
        multiline
        copyable
        hideLabel
      />
    </div>
  </li>
)

export const DialogMineruExternalHelp: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()

  return (
    <Dialog title={language.t("settings.general.mineru.externalHelp.title")} class="w-[min(780px,calc(100vw-24px))]">
      <div
        data-action="settings-mineru-external-help-dialog"
        class="flex max-h-[82vh] flex-col gap-4 overflow-y-auto px-5 pb-5 pt-2"
      >
        <div class="rounded-md bg-background-stronger px-3 py-2.5">
          <p class="text-13-regular leading-5 text-text-base">
            {language.t("settings.general.mineru.externalHelp.description")}
          </p>
        </div>
        <ol class="flex flex-col gap-4">
          <Step
            index={1}
            title={language.t("settings.general.mineru.externalHelp.check.title")}
            description={language.t("settings.general.mineru.externalHelp.check.description")}
            value={commands.check}
            action="settings-mineru-external-help-check"
          />
          <Step
            index={2}
            title={language.t("settings.general.mineru.externalHelp.python.title")}
            description={language.t("settings.general.mineru.externalHelp.python.description")}
            value={commands.python}
            action="settings-mineru-external-help-python"
          />
          <Step
            index={3}
            title={language.t("settings.general.mineru.externalHelp.env.title")}
            description={language.t("settings.general.mineru.externalHelp.env.description")}
            value={commands.env}
            action="settings-mineru-external-help-env"
          />
          <Step
            index={4}
            title={language.t("settings.general.mineru.externalHelp.uv.title")}
            description={language.t("settings.general.mineru.externalHelp.uv.description")}
            value={commands.uv}
            action="settings-mineru-external-help-uv"
          />
          <Step
            index={5}
            title={language.t("settings.general.mineru.externalHelp.install.title")}
            description={language.t("settings.general.mineru.externalHelp.install.description")}
            value={commands.mineru}
            action="settings-mineru-external-help-install"
          />
          <Step
            index={6}
            title={language.t("settings.general.mineru.externalHelp.start.title")}
            description={language.t("settings.general.mineru.externalHelp.start.description")}
            value={commands.start}
            action="settings-mineru-external-help-start"
          />
          <Step
            index={7}
            title={language.t("settings.general.mineru.externalHelp.connect.title")}
            description={language.t("settings.general.mineru.externalHelp.connect.description")}
            value={commands.connect}
            action="settings-mineru-external-help-connect"
          />
        </ol>
        <p class="rounded-md bg-background-stronger px-3 py-2 text-12-regular text-text-weak">
          {language.t("settings.general.mineru.externalHelp.note")}
        </p>
        <div class="flex justify-end">
          <Button variant="primary" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const DialogMineruSetup: Component = () => {
  const global = useGlobalSDK()
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams()
  const models = useModels()
  const dialog = useDialog()
  const directory = createMemo(() => decode64(params.dir))

  const options = createMemo<Option[]>(() =>
    models
      .list()
      .filter(toolcall)
      .map((model) => ({
        providerID: model.provider.id,
        modelID: model.id,
        label: `${model.provider.name} / ${model.name}`,
      })),
  )
  const recent = () =>
    models.recent
      .list()
      .map((item) => options().find((model) => model.providerID === item.providerID && model.modelID === item.modelID))
      .find((item) => item !== undefined)
  const [selected, setSelected] = createSignal<Option | undefined>(recent() ?? options()[0])
  const [busy, setBusy] = createSignal(false)

  const start = async () => {
    const model = selected()
    const dir = directory()
    if (!model || !dir) return
    setBusy(true)
    let linked = false
    try {
      const client = global.createClient({ directory: dir, throwOnError: true })
      const session = await client.session
        .create({ title: language.t("settings.general.mineru.ai.sessionTitle") })
        .then((item) => item.data)
      if (!session) throw new Error("MinerU setup session was not created")
      await global.client.global.mineruManagedSession({ id: session.id, directory: dir }, { throwOnError: true })
      linked = true
      watchMineruMonitor()
      dialog.close()
      navigate(`/${base64Encode(dir)}/session/${session.id}`)
      await client.session.promptAsync({
        sessionID: session.id,
        model: { providerID: model.providerID, modelID: model.modelID },
        parts: [
          {
            type: "text",
            text: language.t("settings.general.mineru.ai.prompt"),
          },
        ],
      })
    } catch (err) {
      if (linked) watchMineruMonitor(false)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
      setBusy(false)
    }
  }

  return (
    <Dialog title={language.t("settings.general.mineru.ai.title")} class="w-[min(560px,calc(100vw-32px))]">
      <div class="flex flex-col gap-4 p-4">
        <div class="rounded-md border border-border-weak-base bg-background-stronger p-3">
          <p class="text-13-medium text-text-strong">{language.t("settings.general.mineru.ai.privacyTitle")}</p>
          <p class="mt-1 text-12-regular text-text-weak">{language.t("settings.general.mineru.ai.privacy")}</p>
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-13-medium text-text-strong">{language.t("settings.general.mineru.ai.model")}</span>
          <p class="text-12-regular text-text-weak">{language.t("settings.general.mineru.ai.toolHint")}</p>
          <Show
            when={options().length > 0}
            fallback={
              <p class="text-12-regular text-danger-base">{language.t("settings.general.mineru.ai.noModel")}</p>
            }
          >
            <Select
              options={options()}
              current={selected()}
              value={(item) => `${item.providerID}/${item.modelID}`}
              label={(item) => item.label}
              onSelect={(item) => item && setSelected(item)}
              variant="secondary"
              triggerStyle={{ width: "100%" }}
            />
          </Show>
        </div>
        <Show when={!directory()}>
          <p class="text-12-regular text-danger-base">{language.t("settings.general.mineru.ai.noProject")}</p>
        </Show>
        <p class="text-12-regular text-text-weak">{language.t("settings.general.mineru.ai.confirmHint")}</p>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button disabled={busy() || !selected() || !directory()} onClick={() => void start()}>
            {language.t(busy() ? "settings.general.mineru.ai.starting" : "settings.general.mineru.ai.start")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const DialogMineruRemove: Component<{ done: () => void }> = (props) => {
  const global = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const [purge, setPurge] = createSignal(false)
  const [plan] = createResource(() =>
    global.client.global
      .mineruManagedUninstall({ throwOnError: true })
      .then((item) => item.data),
  )

  const bytes = (value?: number) => {
    if (value === undefined) return language.t("settings.general.mineru.remove.unknown")
    if (value < 1024) return `${value} B`
    const units = ["KiB", "MiB", "GiB", "TiB"]
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)
    return `${(value / 1024 ** (index + 1)).toFixed(index > 0 ? 1 : 0)} ${units[index]}`
  }

  const remove = async () => {
    setBusy(true)
    try {
      await global.client.global.mineruManagedRemove(
        { adopted: plan()?.runtime === "adopted" && purge() },
        { throwOnError: true },
      )
      props.done()
      dialog.close()
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={language.t("settings.general.mineru.remove.title")}
      class="w-[min(640px,calc(100vw-32px))]"
    >
      <div data-action="settings-mineru-remove-dialog" class="flex max-h-[76vh] flex-col gap-4 overflow-y-auto p-4">
        <Show when={plan.loading}>
          <p class="text-13-regular text-text-weak">{language.t("settings.general.mineru.remove.loading")}</p>
        </Show>
        <Show when={plan.error}>
          <p class="rounded-md bg-surface-critical-weak px-3 py-2 text-12-regular text-text-on-critical-base">
            {formatServerError(plan.error, language.t)}
          </p>
        </Show>
        <Show when={plan()} keyed>
          {(value) => (
            <>
              <p class="text-13-regular leading-5 text-text-strong">
                {language.t(
                  value.runtime === "managed"
                    ? "settings.general.mineru.remove.managed"
                    : "settings.general.mineru.remove.adopted",
                )}
              </p>
              <div class="rounded-md bg-background-stronger px-3 py-2.5">
                <p class="text-12-medium text-text-strong">
                  {language.t(
                    value.runtime === "managed"
                      ? "settings.general.mineru.remove.owned.managed"
                      : "settings.general.mineru.remove.owned.adopted",
                  )}
                  <span class="ml-2 text-12-regular text-text-weak">{bytes(value.owned.size)}</span>
                </p>
                <p class="mt-1 break-all font-mono text-11-regular leading-4 text-text-weak">{value.owned.path}</p>
                <p class="mt-1 text-11-regular leading-4 text-text-weak">
                  {language.t(
                    value.runtime === "managed"
                      ? "settings.general.mineru.remove.owned.managedDescription"
                      : "settings.general.mineru.remove.owned.adoptedDescription",
                  )}
                </p>
              </div>
              <Show when={value.runtime === "adopted"}>
                <Checkbox
                  data-action="settings-mineru-remove-adopted"
                  checked={purge()}
                  onChange={setPurge}
                  description={language.t("settings.general.mineru.remove.purgeDescription")}
                >
                  {language.t("settings.general.mineru.remove.purge")}
                </Checkbox>
                <Show when={purge()}>
                  <div data-action="settings-mineru-remove-targets" class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
                    <p class="text-12-regular leading-5 text-text-on-critical-base">
                      {language.t("settings.general.mineru.remove.warning")}
                    </p>
                    <Show when={value.environment} keyed>
                      {(item) => (
                        <div>
                          <p class="text-12-medium text-text-strong">
                            {language.t("settings.general.mineru.remove.environment")}
                            <span class="ml-2 text-12-regular text-text-weak">{bytes(item.size)}</span>
                          </p>
                          <p class="mt-1 break-all font-mono text-11-regular leading-4 text-text-weak">{item.path}</p>
                        </div>
                      )}
                    </Show>
                    <Show when={value.models.length > 0}>
                      <div>
                        <p class="text-12-medium text-text-strong">
                          {language.t("settings.general.mineru.remove.models")}
                        </p>
                        <ul class="mt-1 flex flex-col gap-1">
                          <For each={value.models}>
                            {(item) => (
                              <li class="break-all font-mono text-11-regular leading-4 text-text-weak">
                                {item.path}
                                <Show when={item.size !== undefined}> · {bytes(item.size)}</Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    </Show>
                    <Show when={value.config} keyed>
                      {(item) => (
                        <div>
                          <p class="text-12-medium text-text-strong">
                            {language.t("settings.general.mineru.remove.config")}
                          </p>
                          <p class="mt-1 break-all font-mono text-11-regular leading-4 text-text-weak">{item}</p>
                        </div>
                      )}
                    </Show>
                  </div>
                </Show>
              </Show>
              <p class="text-12-regular text-text-weak">
                {language.t("settings.general.mineru.remove.expected")}{" "}
                {bytes(value.runtime === "adopted" && !purge() ? value.owned.size : value.removable)} ·{" "}
                {language.t("settings.general.mineru.remove.history")}
              </p>
            </>
          )}
        </Show>
        <div class="flex justify-end gap-2 border-t border-border-weak-base pt-3">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            data-action="settings-mineru-remove-confirm"
            variant="primary"
            disabled={busy() || plan.loading || !plan()}
            onClick={() => void remove()}
          >
            {language.t(
              busy()
                ? "settings.general.mineru.remove.removing"
                : plan()?.runtime === "adopted" && !purge()
                  ? "settings.general.mineru.remove.disconnect"
                  : "settings.general.mineru.remove.confirm",
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const DialogMineruStart: Component<{ resolve: (value: boolean) => void }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const choose = (value: boolean) => {
    props.resolve(value)
    dialog.close()
  }

  return (
    <Dialog
      title={language.t("settings.general.mineru.start.title")}
      class="w-[min(560px,calc(100vw-32px))]"
      persistent
      fit
    >
      <div data-action="mineru-start-dialog" class="flex flex-col gap-3 px-5 pb-5 pt-2">
        <p class="text-13-regular text-text-strong">{language.t("settings.general.mineru.start.description")}</p>
        <p class="text-12-regular text-text-weak">{language.t("settings.general.mineru.start.hint")}</p>
        <div class="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => choose(false)}>
            {language.t("settings.general.mineru.start.decline")}
          </Button>
          <Button onClick={() => choose(true)}>{language.t("settings.general.mineru.start.confirm")}</Button>
        </div>
      </div>
    </Dialog>
  )
}

export function confirmMineruStart(dialog: ReturnType<typeof useDialog>) {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    dialog.show(
      () => <DialogMineruStart resolve={done} />,
      () => done(false),
    )
  })
}
