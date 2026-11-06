import React, { useEffect, useState } from 'react';
import { NavigationContainer, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, Alert, View } from 'react-native';

import { getToken } from './api/client';
import { setUnauthorizedHandler } from './api/session';
import AccountButton from './components/AccountButton';
import LoginScreen from './screens/LoginScreen';
import InstituteListScreen from './screens/InstituteListScreen';
import PrinterListScreen from './screens/PrinterListScreen';
import PrinterDetailScreen from './screens/PrinterDetailScreen';
import PrinterStatusScreen from './screens/PrinterStatusScreen';
import PrintHistoryScreen from './screens/PrintHistoryScreen';
import FinancialStatusScreen from './screens/FinancialStatusScreen';
import RevenueHistoryScreen from './screens/RevenueHistoryScreen';
import AccountScreen from './screens/AccountScreen';
import UsersScreen from './screens/UsersScreen';
import UserEditScreen from './screens/UserEditScreen';

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef();

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

const noAccountButton = { headerRight: () => null };

export default function App() {
  const [initialRoute, setInitialRoute] = useState(null);

  useEffect(() => {
    getToken().then((token) => setInitialRoute(token ? 'InstituteList' : 'Login'));

    // Any API call that comes back 401 (account disabled, password changed elsewhere, token expired) ends up here.
    setUnauthorizedHandler(() => {
      if (!navigationRef.isReady() || navigationRef.getCurrentRoute()?.name === 'Login') return;
      navigationRef.resetRoot({ index: 0, routes: [{ name: 'Login' }] });
      Alert.alert('Signed out', 'Your session has ended. Please sign in again.');
    });
  }, []);

  if (!initialRoute) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0a0e12', justifyContent: 'center' }}>
        <ActivityIndicator color="#36d1dc" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={darkTheme} ref={navigationRef}>
      <Stack.Navigator
        initialRouteName={initialRoute}
        screenOptions={({ navigation }) => ({
          headerStyle: { backgroundColor: '#131a21' },
          headerTintColor: '#fff',
          headerRight: () => <AccountButton navigation={navigation} />,
        })}
      >
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        <Stack.Screen name="InstituteList" component={InstituteListScreen} options={{ title: 'Institutes' }} />
        <Stack.Screen name="PrinterList" component={PrinterListScreen} />
        <Stack.Screen name="PrinterDetail" component={PrinterDetailScreen} />
        <Stack.Screen name="PrinterStatus" component={PrinterStatusScreen} />
        <Stack.Screen name="PrintHistory" component={PrintHistoryScreen} />
        <Stack.Screen name="FinancialStatus" component={FinancialStatusScreen} />
        <Stack.Screen name="RevenueHistory" component={RevenueHistoryScreen} />
        <Stack.Screen name="Account" component={AccountScreen} options={{ title: 'Account', ...noAccountButton }} />
        <Stack.Screen name="Users" component={UsersScreen} options={{ title: 'Users', ...noAccountButton }} />
        <Stack.Screen name="UserEdit" component={UserEditScreen} options={noAccountButton} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}