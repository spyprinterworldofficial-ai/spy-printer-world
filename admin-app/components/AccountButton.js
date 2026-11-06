import React from 'react';
import { TouchableOpacity, Text } from 'react-native';

export default function AccountButton({ navigation }) {
  return (
    <TouchableOpacity onPress={() => navigation.navigate('Account')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <Text style={{ color: '#36d1dc', fontSize: 15, fontWeight: '600' }}>Account</Text>
    </TouchableOpacity>
  );
}