import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { api, saveToken } from '../api/client';
import { registerForPushNotifications } from '../push/notifications';

export default function LoginScreen({ navigation }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) {
      Alert.alert('Missing info', 'Enter both username and password.');
      return;
    }
    setLoading(true);
    try {
      const { token } = await api.login(username, password);
      await saveToken(token);
      // Push registration is best-effort and must never block getting into
      // the app — it also simply doesn't work in Expo Go (removed since
      // SDK 53; needs a proper development build). Any failure here is
      // caught and swallowed inside registerForPushNotifications itself,
      // but this extra guard makes sure that holds even if that changes.
      try {
        await registerForPushNotifications();
      } catch (pushErr) {
        console.log('Push registration skipped:', pushErr.message);
      }
      navigation.replace('InstituteList');
    } catch (err) {
      Alert.alert('Login failed', err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>S.py Admin</Text>
      <Text style={styles.subtitle}>Printer fleet management</Text>

      <TextInput
        style={styles.input}
        placeholder="Username"
        placeholderTextColor="#888"
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#888"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      <TouchableOpacity style={styles.button} onPress={handleLogin} disabled={loading}>
        {loading ? <ActivityIndicator color="#041019" /> : <Text style={styles.buttonText}>Log In</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0e12', justifyContent: 'center', padding: 24 },
  title: { color: '#36d1dc', fontSize: 32, fontWeight: 'bold', textAlign: 'center' },
  subtitle: { color: '#94a3b8', fontSize: 14, textAlign: 'center', marginBottom: 32 },
  input: {
    backgroundColor: '#171f27', color: '#fff', borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 14, marginBottom: 12,
    borderWidth: 1, borderColor: '#2a3644',
  },
  button: {
    backgroundColor: '#36d1dc', borderRadius: 10, paddingVertical: 14,
    alignItems: 'center', marginTop: 12,
  },
  buttonText: { color: '#041019', fontWeight: 'bold', fontSize: 16 },
});