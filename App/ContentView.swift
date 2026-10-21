import NeoPenKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    StatusCard()
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                if !model.isConfigured {
                    Section {
                        NavigationLink {
                            SettingsView()
                        } label: {
                            Label("Collega lo script del PC", systemImage: "link.badge.plus")
                                .foregroundStyle(.orange)
                        }
                    } footer: {
                        Text("Serve una volta sola: indirizzo e chiave sono nella nota «Collegamento iPhone» in Obsidian.")
                    }
                }

                Section("Penna") {
                    if model.ble.hasPen {
                        LabeledContent("Penna", value: model.ble.penName ?? "Neo Smartpen")
                        if let b = model.battery {
                            LabeledContent("Batteria") {
                                Label(b > 100 ? "in carica" : "\(b)%", systemImage: batteryIcon(b))
                            }
                        }
                    } else if model.bleState == .searching {
                        HStack {
                            ProgressView()
                            Text("Cerco la penna… togli il tappo")
                                .padding(.leading, 6)
                        }
                        Button("Annulla") { model.ble.stopSearch() }
                    } else {
                        Button {
                            model.searchPen()
                        } label: {
                            Label("Collega la penna", systemImage: "pencil.tip.crop.circle.badge.plus")
                        }
                        .disabled(model.bleState == .bluetoothOff || model.bleState == .unauthorized)
                    }
                }

                Section {
                    LabeledContent("Pagine sul telefono", value: "\(model.store.pages.count)")
                    LabeledContent("Da inviare al PC", value: "\(model.store.pendingUploads.count)")
                    if let d = model.uploader.lastSuccess {
                        LabeledContent("Ultimo invio", value: d.formatted(date: .omitted, time: .shortened))
                    }
                    if let e = model.uploader.lastError {
                        Text(e).font(.footnote).foregroundStyle(.red)
                    }
                    Button {
                        model.sendNow()
                    } label: {
                        Label(model.uploader.busy ? "Invio in corso…" : "Invia ora", systemImage: "arrow.up.circle")
                    }
                    .disabled(model.uploader.busy || !model.isConfigured)
                } header: {
                    Text("Pagine")
                } footer: {
                    Text("Le pagine vanno allo script Google; il PC con Obsidian aperto le prende e le trascrive.")
                }

                Section {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Label("Impostazioni", systemImage: "gearshape")
                    }
                    NavigationLink {
                        LogView()
                    } label: {
                        Label("Registro", systemImage: "list.bullet.rectangle")
                    }
                }
            }
            .navigationTitle("Neo Pen")
        }
    }

    private func batteryIcon(_ b: Int) -> String {
        switch b {
        case 101...: return "battery.100.bolt"
        case 75...: return "battery.100"
        case 50...: return "battery.75"
        case 25...: return "battery.50"
        case 10...: return "battery.25"
        default: return "battery.0"
        }
    }
}

/// In cima: cosa sta succedendo, in una riga.
struct StatusCard: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let s = status
        HStack(alignment: .center, spacing: 14) {
            ZStack {
                Circle().fill(s.color.opacity(0.15)).frame(width: 52, height: 52)
                Image(systemName: s.icon)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(s.color)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(s.title).font(.headline)
                Text(s.detail).font(.subheadline).foregroundStyle(.secondary)
                if case .syncing(let done, let total) = model.phase {
                    ProgressView(value: Double(done), total: Double(max(1, total)))
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(s.color.opacity(0.25)))
        .padding(.vertical, 4)
    }

    private var status: (title: String, detail: String, icon: String, color: Color) {
        switch model.bleState {
        case .bluetoothOff:
            return ("Bluetooth spento", "Accendilo dal Centro di Controllo.", "antenna.radiowaves.left.and.right.slash", .red)
        case .unauthorized:
            return ("Bluetooth non permesso", "Impostazioni → Neo Pen → Bluetooth.", "hand.raised", .red)
        case .starting:
            return ("Avvio…", "", "hourglass", .gray)
        case .noPen:
            return ("Nessuna penna", "Tocca «Collega la penna» con il tappo tolto.", "pencil.slash", .orange)
        case .searching:
            return ("Cerco la penna…", "Togli il tappo e tienila vicina.", "magnifyingglass", .blue)
        case .waiting:
            return ("In attesa della penna", "Togli il tappo: si collega da sola, anche con l'app chiusa.", "pencil.tip", .gray)
        case .connecting:
            return ("Mi collego…", "", "antenna.radiowaves.left.and.right", .blue)
        case .ready:
            switch model.phase {
            case .handshake:
                return ("Penna accesa", "Mi presento alla penna…", "pencil.tip", .blue)
            case .syncing(let done, let total):
                return ("Scarico la memoria", "Pagina \(min(done + 1, total)) di \(total)", "arrow.down.circle", .blue)
            case .listening:
                return ("Scrivi pure", "Ogni tratto arriva subito sul telefono.", "pencil.and.scribble", .green)
            case .needsPassword:
                return ("Serve la password", "Scrivila nelle impostazioni.", "lock", .orange)
            case .idle:
                return ("Penna collegata", "", "checkmark.circle", .green)
            }
        }
    }
}
