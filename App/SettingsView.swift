import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var testResult: String?
    @State private var testing = false
    @State private var confirmForget = false
    @State private var confirmResend = false

    var body: some View {
        Form {
            Section {
                Button {
                    testResult = model.pasteConfig() ? "Incollati dagli appunti." : "Negli appunti non trovo indirizzo o chiave."
                } label: {
                    Label("Incolla dalla nota «Collegamento iPhone»", systemImage: "doc.on.clipboard")
                }
                TextField("https://script.google.com/…/exec", text: $model.scriptURL, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.footnote.monospaced())
                SecureField("Chiave segreta", text: $model.secret)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    testing = true
                    Task {
                        testResult = await model.testScript()
                        testing = false
                    }
                } label: {
                    if testing { ProgressView() } else { Label("Prova lo script", systemImage: "checkmark.seal") }
                }
                .disabled(!model.isConfigured || testing)
                if let t = testResult {
                    Text(t).font(.footnote).foregroundStyle(.secondary)
                }
            } header: {
                Text("Script del PC")
            } footer: {
                Text("In Obsidian: Impostazioni → Neo Pen → «Lettura dall'iPhone» → «Crea la nota». Copia la nota e tocca «Incolla».")
            }

            Section {
                Toggle("Tratti in tempo reale", isOn: $model.live)
                Toggle("Svuota la penna dopo lo scaricamento", isOn: $model.deleteAfterDownload)
                Toggle("Salta le pagine invariate (prova)", isOn: $model.skipUnchanged)
                SecureField("Password della penna (se ce l'ha)", text: $model.penPassword)
                    .keyboardType(.numberPad)
            } header: {
                Text("Penna")
            } footer: {
                Text("""
                Tempo reale: mentre la penna è collegata ogni tratto arriva subito (la penna allora non lo salva in memoria: lo salva il telefono).
                Svuota la penna: la memoria della penna si cancella dopo che le pagine sono sul telefono, così ogni collegamento scarica solo le novità.
                Salta le invariate: più veloce, ma con Bluefy la penna smetteva di rispondere; provalo e guarda il registro.
                Valgono dal collegamento successivo.
                """)
            }

            Section {
                Button("Rimanda tutte le pagine al PC") { confirmResend = true }
                if model.ble.hasPen {
                    Button("Dimentica la penna", role: .destructive) { confirmForget = true }
                }
            }
        }
        .navigationTitle("Impostazioni")
        .confirmationDialog("Rimandare tutte le pagine al PC?", isPresented: $confirmResend, titleVisibility: .visible) {
            Button("Rimanda tutte") { model.resendAll() }
        }
        .confirmationDialog("Dimenticare la penna?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Dimentica", role: .destructive) { model.forgetPen() }
        } message: {
            Text("Per usarla di nuovo dovrai ricollegarla. Le pagine sul telefono restano.")
        }
    }
}

struct LogView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List(model.log.reversed()) { line in
            VStack(alignment: .leading, spacing: 2) {
                Text(line.time.formatted(date: .omitted, time: .standard))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(line.text).font(.footnote)
            }
        }
        .navigationTitle("Registro")
        .toolbar {
            ShareLink(item: model.logFile) {
                Label("Condividi", systemImage: "square.and.arrow.up")
            }
        }
    }
}
