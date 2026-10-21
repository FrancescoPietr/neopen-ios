Pod::Spec.new do |s|
  s.name           = 'NeoPenBle'
  s.version        = '1.0.0'
  s.summary        = 'Neo Smartpen Bluetooth in the background'
  s.description    = 'CoreBluetooth with state restoration and pending connection for the Neo Smartpen, plus background tasks.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.frameworks     = 'CoreBluetooth'

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
