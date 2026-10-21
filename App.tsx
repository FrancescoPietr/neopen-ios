import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { HomeScreen, LogScreen, SettingsScreen } from "./src/ui/screens";

type Screen = "home" | "settings" | "log";
const TITLES: Record<Screen, string> = { home: "", settings: "Impostazioni", log: "Registro" };

/** Three screens, no router needed: home, settings, log. */
export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
        <StatusBar style="dark" />
        {screen !== "home" ? (
          <View style={styles.bar}>
            <Pressable onPress={() => setScreen("home")} hitSlop={12}>
              <Text style={styles.back}>‹ Neo Pen</Text>
            </Pressable>
            <Text style={styles.title}>{TITLES[screen]}</Text>
            <View style={{ width: 80 }} />
          </View>
        ) : null}
        {screen === "home" ? <HomeScreen go={setScreen} /> : screen === "settings" ? <SettingsScreen /> : <LogScreen />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F2F2F7" },
  bar: { height: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 },
  back: { fontSize: 17, color: "#0A63D6", width: 80 },
  title: { fontSize: 17, fontWeight: "600", color: "#1C1C1E" },
});
