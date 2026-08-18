import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from '../api/client';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerForPushNotifications() {
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device, not a simulator.');
    return;
  }

  // Push notifications were removed from Expo Go starting SDK 53 — they
  // only work in a proper "development build" (EAS build) from here on.
  // Detect Expo Go specifically and skip quietly rather than throwing,
  // since this must never block login or app usage.
  const isExpoGo = Constants.appOwnership === 'expo';
  if (isExpoGo) {
    console.log('Running in Expo Go — push notifications are unavailable here. Use a development build to test them.');
    return;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    console.log('Push notification permission not granted.');
    return;
  }

  // projectId is required to get a push token outside Expo Go — this comes
  // from your EAS project (set up when you first run `eas build` or
  // `eas init`). Until that's done, this will throw, which is caught below
  // rather than crashing the caller.
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    console.log('No EAS projectId configured yet — skipping push token registration.');
    return;
  }

  const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  const expoPushToken = tokenData.data;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  try {
    await api.registerDevice(expoPushToken);
  } catch (err) {
    console.error('Failed to register push token with backend:', err);
  }
}