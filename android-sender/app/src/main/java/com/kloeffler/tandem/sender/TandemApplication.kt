package com.kloeffler.tandem.sender

import android.app.Application

class TandemApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        TandemController.init(this)
    }
}
