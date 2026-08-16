import React, { useEffect, useState } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';

import { getToken } from './api/client';
import LoginScreen from './screens/LoginScreen';
import InstituteListScreen from './screens/InstituteListScreen';
import PrinterListScreen from './screens/PrinterListScreen';
import PrinterDetailScreen from './screens/PrinterDetailScreen';
import PrinterStatusScreen from './screens/PrinterStatusScreen';
import PrintHistoryScreen from './screens/PrintHistoryScreen';
import FinancialStatusScreen from './screens/FinancialStatusScreen';
import RevenueHistoryScreen from './screens/RevenueHistoryScreen';

const Stack = createNativeStackNavigator();

const darkTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#0a0e12',
    card: '#131a21',
    text: '#ffffff',
    border: '#1f2933',
    primary: '#36d1dc',
  },
};

export default function App() {
  const [initialRoute, setInitialRoute] = useState(null);

  useEffect(() => {
    getToken().then((token) => setInitialRoute(token ? 'InstituteList' : 'Login'));
  }, []);

  if (!initialRoute) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0a0e12', justifyContent: 'center' }}>
        <ActivityIndicator color="#36d1dc" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={darkTheme}>
      <Stack.Navigator initialRouteName={initialRoute} screenOptions={{ headerStyle: { backgroundColor: '#131a21' }, headerTintColor: '#fff' }}>
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        <Stack.Screen name="InstituteList" component={InstituteListScreen} options={{ title: 'Institutes' }} />
        <Stack.Screen name="PrinterList" component={PrinterListScreen} />
        <Stack.Screen name="PrinterDetail" component={PrinterDetailScreen} />
        <Stack.Screen name="PrinterStatus" component={PrinterStatusScreen} />
        <Stack.Screen name="PrintHistory" component={PrintHistoryScreen} />
        <Stack.Screen name="FinancialStatus" component={FinancialStatusScreen} />
        <Stack.Screen name="RevenueHistory" component={RevenueHistoryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}