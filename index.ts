import { registerRootComponent } from "expo";

import App from "./App";
import { model } from "./src/app/model";

// The model starts here, before any screen: when iOS relaunches the app in the background for the pen,
// the Bluetooth events must already have someone listening.
model.start();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
registerRootComponent(App);
